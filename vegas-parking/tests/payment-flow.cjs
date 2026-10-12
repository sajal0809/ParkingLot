// Isolated route integration tests: real SQLite transactions, no network or real payments.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const ts=require('typescript');
const db=new DatabaseSync(':memory:');
for(const file of fs.readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())db.exec(fs.readFileSync('drizzle/'+file,'utf8'));
for(const row of ['A','B','C'])for(let n=1;n<=5;n++)db.prepare('INSERT INTO spots (id,status,version) VALUES (?,?,0)').run(row+n,'available');
const d1={prepare(sql){return{bind(...values){return stmt(sql,values)},...stmt(sql,[])}},async batch(statements){db.exec('BEGIN');try{const result=statements.map(s=>s.execute());db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}}};
function stmt(sql,values){return {execute(){const q=db.prepare(sql);return{results:q.all(...values)}},async first(){return db.prepare(sql).get(...values)||null},async all(){return{results:db.prepare(sql).all(...values)}},async run(){return db.prepare(sql).run(...values)}}}
let user={userId:'customer-one',email:'customer@example.test'};
const owner={userId:'operator-one',email:'sajal.sameer12345@gmail.com'};
function load(file,mocks={}){const exports={};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;vm.runInNewContext(code,{exports,require:id=>id in mocks?mocks[id]:require(id),process:{env:{NODE_ENV:'production'}},Response,Request,URL,URLSearchParams,crypto:globalThis.crypto,console:{error(){}}});return exports;}
const payment=load('lib/payment.ts');
const api=load('app/api/parking/route.ts',{'@/app/chatgpt-auth':{getChatGPTUser:async()=>user},'@/lib/parking-db':{seedSpots:async()=>d1},'@/lib/payment':payment});
const state=id=>db.prepare('SELECT * FROM spots WHERE id=?').get(id);
const ledger=id=>db.prepare('SELECT * FROM payment_requests WHERE id=?').get(state(id).booking_id);
async function action(action,spot='A1',extra={}){const r=await api.POST(new Request('https://parking.test/api/parking',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://parking.test'},body:JSON.stringify({action,spot,version:state(spot).version,...extra})}));return{status:r.status,body:await r.json()}}
async function view(operator=false){const r=await api.GET(new Request('https://parking.test/api/parking'+(operator?'?view=operator':'')));return{status:r.status,body:await r.json()}}
(async()=>{
 const customer=user;
 const details={name:'Test Customer',vehicle:'TEST1234'};
 // Eight concurrent reservations yield one allocation, payment request, and event.
 const attempts=await Promise.all(Array.from({length:8},()=>action('reserve','A1',details)));
 assert.equal(attempts.filter(x=>x.status===200).length,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM payment_requests').get().n,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n,1);
 assert.equal(state('A1').status,'pending');assert.equal(ledger('A1').pass_code,null);
 assert.equal((await action('approve-payment','A1',{reference:'123456789012',confirmed:true})).status,403);
 assert.equal((await view(true)).status,403);
 user={userId:'customer-two',email:'second@example.test'};
 assert.equal((await view()).body.spots.find(s=>s.id==='A1').booking_id,null);
 assert.equal((await action('report-payment','A1',{reference:'123456789012'})).status,403);
 user=customer;
 assert.equal((await action('report-payment','A1',{reference:'123456789012'})).status,200);
 assert.equal(ledger('A1').pass_code,null);
 user=owner;
 assert.equal((await action('occupy')).status,409);
 assert.equal((await action('approve-payment','A1',{reference:'123456789012',confirmed:false})).status,422);
 assert.equal((await action('reject-payment','A1',{note:'Please check the UTR.'})).status,200);
 assert.equal(ledger('A1').pass_code,null);
 user=customer;await action('report-payment','A1',{reference:'123456789012'});
 user=owner;
 assert.equal((await action('approve-payment','A1',{reference:'123456789012',confirmed:true})).status,200);
 const pass=ledger('A1').pass_code;assert.match(pass,/^VP-[A-F0-9]{12}$/);
 assert.equal(ledger('A1').verified_by,owner.userId);
 assert.equal((await action('approve-payment','A1',{reference:'999999999999',confirmed:true})).status,409);
 assert.equal(ledger('A1').pass_code,pass);
 assert.equal((await action('occupy')).status,200);
 assert.equal((await action('vacate','A1',{confirmed:false})).status,422);
 const firstId=state('A1').booking_id;
 assert.equal((await action('vacate','A1',{confirmed:true})).status,200);
 assert.equal(db.prepare('SELECT lifecycle FROM payment_requests WHERE id=?').get(firstId).lifecycle,'completed');
 user=customer;await action('reserve','B1',details);await action('report-payment','B1',{reference:'123456789012'});
 user=owner;
 assert.equal((await action('approve-payment','B1',{reference:'123456789012',confirmed:true})).status,409);
 assert.equal(ledger('B1').pass_code,null);assert.equal(state('B1').status,'pending');
 assert.equal((await action('cancel','B1',{confirmed:true})).status,200);
 // Race to reuse a new receipt across two requests: exactly one approval wins.
 user=customer;
 for(const id of ['C1','C2']){await action('reserve',id,details);await action('report-payment',id,{reference:'888888888888'})}
 user=owner;
 const approvals=await Promise.all(['C1','C2'].map(id=>action('approve-payment',id,{reference:'888888888888',confirmed:true})));
 assert.equal(approvals.filter(x=>x.status===200).length,1);
 assert.equal(approvals.filter(x=>x.status===409).length,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM payment_requests WHERE receipt_ref='888888888888'").get().n,1);
 const loser=['C1','C2'].find(id=>!ledger(id).pass_code);assert.equal(state(loser).status,'pending');
 // Distinct customers see the same free spot: only one wins the atomic claim.
 const beforeRequests=db.prepare('SELECT COUNT(*) n FROM payment_requests').get().n;
 const beforeEvents=db.prepare('SELECT COUNT(*) n FROM events').get().n;
 const contenders=await Promise.all(Array.from({length:30},(_,i)=>{
  user={userId:'racer-'+i,email:'racer-'+i+'@example.test'};
  return action('reserve','A2',{name:'Racer '+i,vehicle:'RACE'+i,version:0});
 }));
 assert.equal(contenders.filter(r=>r.status===200).length,1);
 assert.equal(contenders.filter(r=>r.status===409).length,29);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM payment_requests').get().n,beforeRequests+1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n,beforeEvents+1);
 const winner=contenders.findIndex(r=>r.status===200);
 assert.equal(state('A2').owner,'racer-'+winner);
 assert.equal(ledger('A2').owner,state('A2').owner);
 assert.equal((await view()).body.spots.find(s=>s.id==='A2').status,'pending');
 // A delayed request cannot reserve a spot after it is freed and reused (ABA).
 user=owner;assert.equal((await action('cancel','A2',{confirmed:true})).status,200);
 user=customer;assert.equal((await action('reserve','A2',{...details,version:0})).status,409);
 assert.equal(state('A2').status,'available');
 assert.equal((await action('reserve','A2',details)).status,200);
 // Operator blocking and customer booking compete for the same version.
 user=owner;const block=action('block','B2',{version:0});
 user=customer;const reserve=action('reserve','B2',{...details,version:0});
 const mixed=await Promise.all([block,reserve]);
 assert.equal(mixed.filter(r=>r.status===200).length,1);
 assert.equal(mixed.filter(r=>r.status===409).length,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM payment_requests WHERE spot_id='B2' AND lifecycle='active'").get().n,state('B2').status==='pending'?1:0);
 // A blocked spot is unavailable even if a caller knows its current version.
 user=owner;await action('block','B3');user=customer;
 assert.equal((await action('reserve','B3',details)).status,409);
 assert.equal((await action('vacate','B3',{confirmed:true})).status,403);
 const publicView=await api.GET(new Request('https://parking.test/api/parking'));
 assert.equal(publicView.headers.get('Cache-Control'),'no-store');
 const availability=load('lib/availability.ts');
 assert.equal(availability.isAvailabilityFresh(1000,15999,true,false),true);
 assert.equal(availability.isAvailabilityFresh(1000,16000,true,false),false);
 assert.equal(availability.isAvailabilityFresh(1000,1001,false,false),false);
 assert.equal(availability.isAvailabilityFresh(1000,1001,true,true),false);
 assert.equal(availability.isAvailabilityFresh(0,1001,true,false),false);
 assert.deepEqual(JSON.parse(JSON.stringify(availability.mergeSpotVersions([{id:'A1',version:5,status:'pending'}],[{id:'A1',version:4,status:'available'}]))),[{id:'A1',version:5,status:'pending'}]);
 assert.equal(availability.mergeSpotVersions([{id:'A1',version:5,status:'pending'}],[{id:'A1',version:6,status:'available'}])[0].status,'available');
 // Customer support requires ownership and an approved, active booking.
 user=customer;await action('reserve','A3',details);
 assert.equal((await action('report-issue','A3',{note:'Blocked'})).status,409);
 await action('report-payment','A3',{reference:'SUPPORT123'});
 user=owner;await action('approve-payment','A3',{reference:'SUPPORT123',confirmed:true});
 const supportPass=ledger('A3').pass_code;
 user={userId:'stranger',email:'stranger@example.test'};
 assert.equal((await action('report-issue','A3',{note:'Blocked'})).status,403);
 user=customer;
 assert.equal((await action('report-issue','A3',{note:'Another vehicle is here'})).status,200);
 assert.equal((await action('report-issue','A3',{note:'Duplicate'})).status,409);
 assert.equal(state('A3').status,'reserved');
 assert.equal((await action('resolve-issue','A3',{note:'Clear',confirmed:true})).status,403);
 user=owner;
 assert.equal((await action('resolve-issue','A3',{note:'Clear',confirmed:false})).status,422);
 assert.equal((await action('resolve-issue','A3',{note:'Attendant removed obstruction',confirmed:true})).status,200);
 assert.equal(ledger('A3').issue_status,'resolved');
 user=customer;await action('report-issue','A3',{note:'Still obstructed'});
 user=owner;
 assert.equal((await action('reassign','A3',{target:'A3',targetVersion:state('A3').version,confirmed:true})).status,422);
 assert.equal((await action('reassign','A3',{target:'B3',targetVersion:state('B3').version,confirmed:true})).status,409);
 assert.equal(state('A3').status,'reserved');assert.equal(ledger('A3').pass_code,supportPass);
 const sourceBooking=state('A3').booking_id;
 assert.equal((await action('reassign','A3',{target:'A4',targetVersion:state('A4').version,confirmed:true})).status,200);
 assert.equal(state('A3').status,'blocked');assert.equal(state('A3').booking_id,null);
 assert.equal(state('A4').booking_id,sourceBooking);assert.equal(ledger('A4').pass_code,supportPass);
 assert.equal(ledger('A4').spot_id,'A4');assert.equal(ledger('A4').issue_status,'resolved');
 user=customer;
 const movedBooking=(await view()).body.spots.find(s=>s.id==='A4');
 assert.equal(movedBooking.mine,true);assert.match(movedBooking.issue_resolution,/A3 to A4/);
 await action('report-issue','A4',{note:'Need another replacement'});
 user=owner;const moveAttempt=action('reassign','A4',{target:'A5',targetVersion:state('A5').version,confirmed:true});
 user=customer;const competingBooking=action('reserve','A5',details);
 const contested=await Promise.all([moveAttempt,competingBooking]);
 assert.equal(contested.filter(x=>x.status===200).length,1);assert.equal(contested.filter(x=>x.status===409).length,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM spots WHERE booking_id=?").get(sourceBooking).n,1);
 console.log('PASS: issue ownership, paid-only reporting, duplicate prevention, resolution confirmation, blocked-target rejection, atomic reassignment, pass preservation and reassignment/booking race.');
 const link=new URL(payment.upiLink('REQ-TEST'));
 assert.equal(link.protocol,'upi:');assert.equal(link.searchParams.get('pa'),'sajal.sameer12345@oksbi');assert.equal(link.searchParams.get('am'),'15.00');
 console.log('PASS: 30 competing customers, reserve/block race, stale versions after release, stale/offline availability and out-of-order responses; payment gating, ownership, operator authorization, rejection, duplicate receipt prevention, concurrent allocation/approval rollback, occupancy, vacancy, ledger retention, and UPI destination. No real payment made.');
})().catch(e=>{console.error(e);process.exitCode=1});
