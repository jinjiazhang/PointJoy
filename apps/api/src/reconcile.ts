import { buildApp } from './main.js';
import { reconcile } from './domain/index.js';
const {app,services}=await buildApp();try{const result=await reconcile(services);process.stdout.write(JSON.stringify(result,null,2)+'\n');if(result.status!=='PASS')process.exitCode=1;}finally{await app.close();}
