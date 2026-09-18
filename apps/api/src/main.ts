import 'reflect-metadata';
import 'dotenv/config';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, static as serveStatic } from 'express';
import { avatarDir } from './avatar';
import { ApiController } from './controller';
import { db } from './domain';
@Module({controllers:[ApiController]})
class AppModule {}
async function bootstrap(){
 if(process.env.DEMO_AUTH==='true'&&(process.env.NODE_ENV==='production'||(process.env.HOST&&process.env.HOST!=='127.0.0.1')))throw new Error('Demo authentication is restricted to local development');
 const app=await NestFactory.create(AppModule,{bodyParser:false});
 app.getHttpAdapter().getInstance().set('trust proxy','loopback');
 app.use('/api/v1/me/avatar',json({limit:'3mb'}));
 app.use(json({limit:'100kb'}));
 app.use('/api/v1/avatars',serveStatic(avatarDir,{immutable:true,maxAge:'1y',index:false,dotfiles:'deny'}));
 app.enableCors({origin:['http://localhost:5178','http://127.0.0.1:5178']});
 await db.$connect();await app.listen(Number(process.env.PORT||4100),process.env.HOST||'127.0.0.1');
 console.log('PointJoy API ready on http://127.0.0.1:4100/api/v1');
}
bootstrap();
