import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';

export const avatarDir=resolve(process.env.AVATAR_DIR||'work/avatars');
export async function saveAvatar(encoded:string):Promise<string>{
 let image:Buffer;
 try {
  if(encoded.length>2800000||encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error();
  const raw=Buffer.from(encoded,'base64');
  const metadata=await sharp(raw,{limitInputPixels:16000000}).metadata();
  if(!['jpeg','png','webp'].includes(metadata.format||''))throw new Error();
  image=await sharp(raw,{limitInputPixels:16000000}).rotate().resize(256,256,{fit:'cover'}).jpeg({quality:85}).toBuffer();
 }catch{throw new HttpException({code:'INVALID_AVATAR',message:'请选择不超过 2 MB 的 JPG、PNG 或 WebP 图片'},400);}
 const name=createHash('sha256').update(image).digest('hex')+'.jpg';
 await mkdir(avatarDir,{recursive:true});
 await writeFile(resolve(avatarDir,name),image,{mode:0o644});
 return (process.env.PUBLIC_BASE_URL||'http://127.0.0.1:4100')+'/api/v1/avatars/'+name;
}
