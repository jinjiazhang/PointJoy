import sharp from 'sharp';
import { unlink } from 'node:fs/promises';
sharp.concurrency(1);
sharp.cache(false);
process.on('message', async (input:any) => {
 try {
  const original = sharp(input.inputPath,{limitInputPixels:40_000_000,failOn:'warning',animated:false});
  const info = await original.metadata();
  if(!['jpeg','png','webp'].includes(info.format||'') || !info.width || !info.height || info.width*info.height>40_000_000 || (info.pages||1)>1) throw new Error('INVALID_IMAGE');
  const oriented = await original.rotate().toBuffer();
  let image = sharp(oriented,{limitInputPixels:40_000_000});
  if(input.purpose!=='COMPLETION_EVIDENCE') {
   const dimensions = await image.metadata();
   const width=dimensions.width!,height=dimensions.height!;
   const crop=input.crop||{x:Math.floor((width-Math.min(width,height))/2),y:Math.floor((height-Math.min(width,height))/2),width:Math.min(width,height),height:Math.min(width,height)};
   if(crop.x<0||crop.y<0||crop.width<1||crop.height<1||crop.x+crop.width>width||crop.y+crop.height>height) throw new Error('INVALID_CROP');
   image=image.extract({left:crop.x,top:crop.y,width:crop.width,height:crop.height}).resize(512,512,{fit:'cover'});
  } else image=image.resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true});
  const output=await image.flatten({background:'#ffffff'}).jpeg({quality:85,mozjpeg:true}).toFile(input.outputPath);
  process.send?.({ok:true,width:output.width,height:output.height});
 } catch(error:any) { await unlink(input.outputPath).catch(()=>{}); process.send?.({ok:false,code:error.message==='INVALID_CROP'?'INVALID_CROP':'INVALID_IMAGE'}); }
 setTimeout(()=>process.exit(0),25);
});
