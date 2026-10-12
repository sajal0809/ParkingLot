export const AVAILABILITY_MAX_AGE_MS = 15_000;
export function isAvailabilityFresh(checkedAt:number, now:number, online:boolean, failed:boolean){
  return online && !failed && checkedAt>0 && now-checkedAt<AVAILABILITY_MAX_AGE_MS;
}
// A slow response must never replace newer spot versions already on screen.
export function mergeSpotVersions<T extends {id:string;version:number}>(previous:T[],incoming:T[]):T[]{
  const byId=new Map(previous.map(spot=>[spot.id,spot]));
  return incoming.map(spot=>{const old=byId.get(spot.id);return old&&old.version>spot.version?old:spot});
}
