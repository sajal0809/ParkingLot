import {env} from 'cloudflare:workers';
export function parkingDb(){if(!env.DB)throw new Error('Parking storage is unavailable');return env.DB;}
export async function seedSpots(){const db=parkingDb();const count=await db.prepare('SELECT COUNT(*) AS n FROM spots').first<{n:number}>();if(!count||count.n<15)await db.batch(['A','B','C'].flatMap(row=>[1,2,3,4,5].map(n=>db.prepare('INSERT OR IGNORE INTO spots (id,status,version) VALUES (?, ?, 0)').bind(row+n,'available'))));return db;}
