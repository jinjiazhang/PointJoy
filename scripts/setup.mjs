import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const envPath='apps/api/.env';
if(!existsSync(envPath)){
 const template=readFileSync('apps/api/.env.example','utf8').replace('replace_with_64_hex_characters',randomBytes(32).toString('hex'));
 writeFileSync(envPath,template,{mode:0o600});
}
for(const [cmd,args] of [
 ['docker',['compose','up','-d','--wait']],
 ['npm',['run','db:generate','-w','apps/api']],
 ['npm',['run','db:migrate']],
 ['npm',['run','db:seed']]
])execFileSync(cmd,args,{stdio:'inherit'});
console.log('Ready. Run npm run dev and open http://127.0.0.1:5178');
