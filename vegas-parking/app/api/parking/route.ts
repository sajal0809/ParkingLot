import {z} from 'zod';
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {seedSpots} from '@/lib/parking-db';
import {FEE_PAISE,UPI_ID,isOperator,normalizeReference} from '@/lib/payment';
const input=z.object({
 action:z.enum(['reserve','report-payment','approve-payment','reject-payment','occupy','vacate','block','cancel','report-issue','resolve-issue','reassign']),
 spot:z.string().regex(/^[ABC][1-5]$/),version:z.number().int().nonnegative(),
 name:z.string().max(60).optional(),vehicle:z.string().max(20).optional(),confirmed:z.boolean().optional(),
 target:z.string().regex(/^[ABC][1-5]$/).optional(),targetVersion:z.number().int().nonnegative().optional(),
 reference:z.string().max(40).optional(),note:z.string().max(250).optional(),
});
export async function GET(request:Request){
 try{
  const user=await getChatGPTUser();
  if(!user)return Response.json({error:'Please sign in to reserve parking.'},{status:401});
  const staff=isOperator(user),operatorView=new URL(request.url).searchParams.get('view')==='operator';
  if(operatorView&&!staff)return Response.json({error:'Only the parking operator can access this view.'},{status:403});
  const db=await seedSpots();
  const result=await db.prepare(`SELECT s.*,p.status AS payment_status,p.submitted_ref,p.receipt_ref,p.pass_code,p.verified_at,p.note AS payment_note,p.issue_status,p.issue_note,p.issue_resolution FROM spots s LEFT JOIN payment_requests p ON p.id=s.booking_id ORDER BY s.id`).all<Record<string,unknown>>();
  const spots=result.results.map(s=>{
   const own=s.owner===user.userId;
   if(!operatorView&&!own)return {id:s.id,status:s.status,version:s.version,booking_id:null,name:null,vehicle:null,created_at:null,mine:false};
   return {...s,mine:own,owner:undefined};
  });
  const events=operatorView?(await db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT 12').all()).results:[];
  return Response.json({spots,events,canOperate:staff,upiId:UPI_ID,feePaise:FEE_PAISE},{headers:{'Cache-Control':'no-store'}});
 }catch(e){console.error(e);return Response.json({error:'Parking availability could not be loaded. Please retry.'},{status:503});}
}
export async function POST(request:Request){
 try{
  const user=await getChatGPTUser();
  if(!user)return Response.json({error:'Please sign in first.'},{status:401});
  const origin=request.headers.get('origin');
  if(origin&&origin!==new URL(request.url).origin)return Response.json({error:'Invalid origin'},{status:403});
  let body;try{body=input.parse(await request.json());}catch{return Response.json({error:'Invalid request.'},{status:422});}
  const {action,spot,version}=body;
  const staff=isOperator(user);
  if(!['reserve','report-payment','report-issue'].includes(action)&&!staff)return Response.json({error:'Only the operator can perform this action.'},{status:403});
  const db=await seedSpots();
  const old=await db.prepare('SELECT * FROM spots WHERE id=?').bind(spot).first<{booking_id:string|null,owner:string|null,version:number,status:string}>();
  if(!old||old.version!==version)return Response.json({error:action==='reserve'?'This spot changed while you were booking. Check the refreshed map and choose an available spot.':'This spot changed. Review its latest details before trying again.',code:'SPOT_CHANGED'},{status:409});
  const statements:D1PreparedStatement[]=[];
  let label='';
  const operation=crypto.randomUUID();
  const changeGuard='EXISTS (SELECT 1 FROM spots WHERE id=? AND mutation_id=?)';
  const mutate=(sql:string)=>db.prepare(sql.replace('UPDATE spots SET ',`UPDATE spots SET mutation_id='${operation}',`));
  if(action==='reserve'){
   const name=(body.name||'').trim(),vehicle=(body.vehicle||'').trim().toUpperCase();
   if(name.length<2||vehicle.length<4)return Response.json({error:'Enter your name and vehicle registration.'},{status:422});
   const id='REQ-'+crypto.randomUUID().replaceAll('-','').slice(0,16).toUpperCase();
   statements.push(mutate("UPDATE spots SET status='pending',booking_id=?,owner=?,name=?,vehicle=?,created_at=?,version=version+1 WHERE id=? AND version=? AND status='available' RETURNING *").bind(id,user.userId,name,vehicle,Date.now(),spot,version));
   statements.push(db.prepare(`INSERT INTO payment_requests (id,spot_id,owner,status,amount_paise,created_at,lifecycle) SELECT ?,?,?,'pending',?,?,'active' WHERE ${changeGuard}`).bind(id,spot,user.userId,FEE_PAISE,Date.now(),spot,operation));
   label='Spot held — awaiting UPI payment';
  }else if(action==='report-issue'||action==='resolve-issue'){
   if(action==='report-issue'&&old.owner!==user.userId)return Response.json({error:'This booking does not belong to you.'},{status:403});
   if(!body.note?.trim())return Response.json({error:'Please describe the problem or resolution.'},{status:422});
   if(action==='resolve-issue'&&!body.confirmed)return Response.json({error:'Confirm you checked the spot and helped the customer.'},{status:422});
   const resolving=action==='resolve-issue';
   statements.push(mutate(`UPDATE spots SET version=version+1 WHERE id=? AND version=? AND status IN ('reserved','occupied') AND EXISTS (SELECT 1 FROM payment_requests WHERE id=spots.booking_id AND status='approved' AND lifecycle='active' AND ${resolving?"issue_status='open'":"(issue_status IS NULL OR issue_status='resolved')"}) RETURNING *`).bind(spot,version));
   statements.push(db.prepare(resolving?`UPDATE payment_requests SET issue_status='resolved',issue_resolution=? WHERE id=? AND ${changeGuard}`:`UPDATE payment_requests SET issue_status='open',issue_note=?,issue_resolution=NULL WHERE id=? AND ${changeGuard}`).bind(body.note.trim(),old.booking_id,spot,operation));
   label=resolving?'Spot problem resolved: '+body.note.trim():'Customer needs help: '+body.note.trim();
  }else if(action==='reassign'){
   if(!body.confirmed||!body.target||body.target===spot||body.targetVersion===undefined)return Response.json({error:'Select a different available spot and confirm you inspected it.'},{status:422});
   const target=body.target;
   // Claim the replacement and move the booking in one transaction. The original
   // spot remains blocked until an operator physically clears it.
   const moved=`EXISTS (SELECT 1 FROM spots WHERE id=? AND mutation_id=?)`;
   statements.push(mutate(`UPDATE spots SET status='reserved',booking_id=(SELECT booking_id FROM spots WHERE id=?),owner=(SELECT owner FROM spots WHERE id=?),name=(SELECT name FROM spots WHERE id=?),vehicle=(SELECT vehicle FROM spots WHERE id=?),created_at=(SELECT created_at FROM spots WHERE id=?),version=version+1 WHERE id=? AND version=? AND status='available' AND EXISTS (SELECT 1 FROM spots s JOIN payment_requests p ON p.id=s.booking_id WHERE s.id=? AND s.version=? AND s.status='reserved' AND p.status='approved' AND p.issue_status='open' AND p.lifecycle='active') RETURNING *`).bind(spot,spot,spot,spot,spot,target,body.targetVersion,spot,version));
   statements.push(mutate(`UPDATE spots SET status='blocked',booking_id=NULL,owner=NULL,name=NULL,vehicle=NULL,created_at=NULL,version=version+1 WHERE id=? AND version=? AND ${moved}`).bind(spot,version,target,operation));
   statements.push(db.prepare(`UPDATE payment_requests SET spot_id=?,issue_status='resolved',issue_resolution=? WHERE id=? AND ${moved}`).bind(target,`Your reservation has moved from ${spot} to ${target}. Show the same pass to the attendant.`,old.booking_id,target,operation));
   statements.push(db.prepare(`INSERT INTO events (id,spot_id,action,created_at) SELECT ?,?,?,? WHERE ${moved}`).bind(crypto.randomUUID(),target,`Reservation reassigned from ${spot}`,Date.now(),target,operation));
   label=`Reservation moved to ${target}. Original spot ${spot} remains blocked.`;
  }else if(action==='report-payment'){
   if(old.owner!==user.userId)return Response.json({error:'This payment request does not belong to you.'},{status:403});
   const ref=normalizeReference(body.reference||'');
   if(!/^[A-Z0-9]{6,40}$/.test(ref))return Response.json({error:'Enter the transaction reference from your UPI receipt (6–40 letters or digits).'}, {status:422});
   statements.push(mutate("UPDATE spots SET version=version+1 WHERE id=? AND version=? AND status='pending' RETURNING *").bind(spot,version));
   statements.push(db.prepare(`UPDATE payment_requests SET status='reported',submitted_ref=?,note=NULL WHERE id=? AND status IN ('pending','reported') AND ${changeGuard}`).bind(ref,old.booking_id,spot,operation));
   label='Customer reported payment — operator verification required';
  }else if(action==='approve-payment'){
   const ref=normalizeReference(body.reference||'');
   if(!body.confirmed||!/^[A-Z0-9]{6,40}$/.test(ref))return Response.json({error:'Check your receiving account, enter its transaction reference, and confirm receipt of ₹15.'},{status:422});
   const duplicate=await db.prepare('SELECT id FROM payment_requests WHERE receipt_ref=?').bind(ref).first();
   if(duplicate)return Response.json({error:'This received transaction has already been used for a parking pass.'},{status:409});
   const pass='VP-'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase();
   statements.push(mutate("UPDATE spots SET status='reserved',version=version+1 WHERE id=? AND version=? AND status='pending' AND EXISTS (SELECT 1 FROM payment_requests WHERE id=spots.booking_id AND status='reported' AND lifecycle='active') RETURNING *").bind(spot,version));
   statements.push(db.prepare(`UPDATE payment_requests SET status='approved',receipt_ref=?,pass_code=?,verified_by=?,verified_at=?,note=NULL WHERE id=? AND status='reported' AND ${changeGuard}`).bind(ref,pass,user.userId,Date.now(),old.booking_id,spot,operation));
   label='₹15 receipt verified by operator — parking pass issued';
  }else if(action==='reject-payment'){
   if(!body.note?.trim())return Response.json({error:'Add a short reason so the customer knows what to correct.'},{status:422});
   statements.push(mutate("UPDATE spots SET version=version+1 WHERE id=? AND version=? AND status='pending' RETURNING *").bind(spot,version));
   statements.push(db.prepare(`UPDATE payment_requests SET status='pending',note=? WHERE id=? AND status IN ('pending','reported') AND ${changeGuard}`).bind(body.note.trim(),old.booking_id,spot,operation));
   label='Payment needs review — no pass issued';
  }else{
   const transitions:Record<string,[string[],string,string]>={occupy:[['reserved'],'occupied','Vehicle parked'],vacate:[['occupied','blocked'],'available','Empty spot and cone confirmed'],block:[['available'],'blocked','Spot blocked'],cancel:[['pending','reserved'],'available','Reservation cancelled by operator']};
   const t=transitions[action];
   if(!t)return Response.json({error:'Invalid action'},{status:422});
   if(['vacate','cancel'].includes(action)&&!body.confirmed)return Response.json({error:'Confirm the spot is empty and the cone is restored.'},{status:422});
   const clear=t[1]==='available';
   const paidGuard=action==='occupy'?" AND EXISTS (SELECT 1 FROM payment_requests WHERE id=spots.booking_id AND status='approved' AND pass_code IS NOT NULL AND lifecycle='active')":'';
   statements.push(mutate(`UPDATE spots SET status=?,version=version+1${clear?',booking_id=NULL,owner=NULL,name=NULL,vehicle=NULL,created_at=NULL':''} WHERE id=? AND version=? AND status IN (${t[0].map(()=>'?').join(',')})${paidGuard} RETURNING *`).bind(t[1],spot,version,...t[0]));
   if(clear&&old.booking_id)statements.push(db.prepare(`UPDATE payment_requests SET lifecycle=?,note=CASE WHEN ?='cancelled' THEN 'Cancelled by operator. Any received payment must be reconciled or refunded manually; no automatic refund is sent.' ELSE note END WHERE id=? AND ${changeGuard}`).bind(action==='cancel'?'cancelled':'completed',action==='cancel'?'cancelled':'completed',old.booking_id,spot,operation));
   label=t[2];
  }
  statements.push(db.prepare(`INSERT INTO events (id,spot_id,action,created_at) SELECT ?,?,?,? WHERE ${changeGuard}`).bind(crypto.randomUUID(),spot,label,Date.now(),spot,operation));
  // A D1 batch is transactional. A unique receipt reference prevents reusing a payment.
  const results=await db.batch(statements);
  if(!results[0].results.length)return Response.json({error:action==='reserve'?'Someone else has just reserved or blocked this spot. Choose another available spot.':'This action is no longer valid. Review the refreshed spot before trying again.',code:'SPOT_CHANGED'},{status:409});
  return Response.json({message:label});
 }catch(e){console.error(e);const duplicate=String(e).includes('UNIQUE');return Response.json({error:duplicate?'This payment reference has already been used. No pass was issued.':'The update could not be saved. Refresh to check its status before retrying.'},{status:duplicate?409:503});}
}
