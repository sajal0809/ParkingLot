export const UPI_ID = 'sajal.sameer12345@oksbi';
export const FEE_PAISE = 1500;
export const OPERATOR_EMAIL = 'sajal.sameer12345@gmail.com';
export function upiLink(requestId:string){
  const params=new URLSearchParams({pa:UPI_ID,pn:'Sajal Sameer',am:'15.00',cu:'INR',tn:`Vegas parking ${requestId}`});
  return `upi://pay?${params.toString()}`;
}
export function normalizeReference(value:string){return value.replace(/\s/g,'').toUpperCase();}
export function isOperator(user:{email:string,userId:string}){
  return user.email.toLowerCase()===OPERATOR_EMAIL ||
    (process.env.NODE_ENV!=='production'&&user.userId==='local_seedy'&&user.email==='seedy@sites.test');
}
