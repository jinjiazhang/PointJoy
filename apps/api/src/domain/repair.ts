import pg from 'pg';
import { loadConfig } from '../common/config.js';
import { type Services, z } from '../common/index.js';
import { resolveIncidents } from './jobs.js';

const args=process.argv.slice(2),fields:Record<string,string>={};
for(let i=0;i<args.length;i+=2){
  if(!args[i]?.startsWith('--')||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Usage: reconcile:resolve --family UUID [--child UUID] --operator NAME --reason TEXT');
  fields[args[i].slice(2)]=args[i+1];
}
const input=z.object({family:z.string().uuid(),child:z.string().uuid().optional(),operator:z.string().trim().min(1).max(100),reason:z.string().trim().min(1).max(1000)}).strict().parse(fields);
const config=loadConfig(),pool=new pg.Pool({connectionString:config.databaseUrl});
try{
  const result=await resolveIncidents({pool,config} as Services,{familyId:input.family,childId:input.child,operator:input.operator,reason:input.reason});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}finally{await pool.end();}
