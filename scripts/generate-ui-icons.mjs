// Original geometric icons, rasterized for reliable WeChat image rendering.
import fs from 'node:fs/promises';
import sharp from 'sharp';
const icons={
 home:'<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2Z"/>',
 list:'<rect x="4" y="3" width="16" height="18" rx="4"/><path d="M9 8h7M9 12h7M9 16h4"/>',
 gift:'<rect x="3" y="9" width="18" height="4" rx="1.5"/><path d="M5 13v7h14v-7M12 9v11M12 9H8a3 3 0 1 1 3-3l1 3Zm0 0h4a3 3 0 1 0-3-3Z"/>',
 family:'<circle cx="8" cy="7" r="3"/><circle cx="17" cy="8" r="2.5"/><path d="M2.5 20v-2a5.5 5.5 0 0 1 11 0v2M16 14a4.5 4.5 0 0 1 5.5 4.4V20"/>',
 sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
 sparkle:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4"/>',
 check:'<path d="m5 12 4.5 4.5L19 7"/>',plus:'<path d="M12 5v14M5 12h14"/>',
 chevron:'<path d="m9 5 7 7-7 7"/>',arrow:'<path d="m14 5-7 7 7 7M7 12h14"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 activity:'<path d="M2 13h4l3-8 5 14 3-6h5"/>',
 calendar:'<rect x="3" y="5" width="18" height="16" rx="4"/><path d="M7 3v4m10-4v4M3 11h18M8 15h1m6 0h1M8 18h1"/>',
 star:'<path d="m12 3 2.8 5.6 6.2.9-4.5 4.4 1 6.1-5.5-2.9L6.5 20l1-6.1L3 9.5l6.2-.9Z"/>',
 shield:'<path d="m12 3 8 3v6c0 4-3.5 7-8 9-4.5-2-8-5-8-9V6ZM8 12l3 3 5-6"/>',
 settings:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2.5"/><circle cx="16" cy="12" r="2.5"/><circle cx="10" cy="18" r="2.5"/>',
 heart:'<path d="M20.5 4.5a5 5 0 0 0-7 0L12 6l-1.5-1.5a5 5 0 0 0-7 7L12 20l8.5-8.5a5 5 0 0 0 0-7Z"/>',
 chart:'<path d="M4 20V4M4 20h17M8 16v-4m5 4V8m5 8V4"/>',
 edit:'<path d="m14 5 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15ZM4 20l1-5"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>',
 leaf:'<path d="M20 3C8 2 2 8 5 15c3 7 15 4 15-12ZM5 21 16 8M9 17l-1-6"/>',
 game:'<path d="M7 7h10a4 4 0 0 1 4 3l1 6a3 3 0 0 1-5 3l-2-2H9l-2 2a3 3 0 0 1-5-3l1-6a4 4 0 0 1 4-3Z"/><path d="M7 10v5m-2.5-2.5h5M16 11h.1M19 14h.1"/>',
 icecream:'<path d="M5 10a3 3 0 0 1 1-5 6 6 0 0 1 12 0 3 3 0 0 1 1 5ZM7 10l5 12 5-12M10 15h4"/>',
 fries:'<path d="M6 10 5 21h14l-1-11ZM7 10V3h3v7m2 0V2h3v8m2 0V5h3v7M9 15h6"/>',
 book:'<path d="M12 5C8 2 4 3 2 4v16c4-2 7-1 10 1 3-2 6-3 10-1V4c-2-1-6-2-10 1ZM12 5v16M6 8h2m-2 4h2m8-4h2m-2 4h2"/>',
 outing:'<path d="m2 20 7-12 4 6 3-5 6 11ZM6 14l3 1 2-3"/><circle cx="17" cy="4" r="2"/>',
 archive:'<rect x="3" y="3" width="18" height="5" rx="1.5"/><path d="M5 8v12h14V8M9 12h6"/>',
 download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
 lock:'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
 history:'<path d="M3 11a9 9 0 1 1 2 7M3 5v6h6M12 7v5l4 2"/>',
 user:'<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
 camera:'<path d="M4 6h4l2-3h4l2 3h4a2 2 0 0 1 2 2v11H2V8a2 2 0 0 1 2-2Z"/><circle cx="12" cy="12" r="4"/>',
 wechat:'<path d="M14 15c-1 .5-2 .7-3 .7l-4 3v-3.3C4 14.1 2 12 2 9c0-4 4-7 9-7s9 3 9 7"/><path d="M22 15c0 3-3 5-6 5h-1l-3 2v-3c-2-1-3-2-3-4 0-3 3-5 6.5-5S22 12 22 15Z"/><path d="M7 7h.1M13 7h.1M13 14h.1M18 14h.1"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
 bell:'<path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8ZM9 20a3 3 0 0 0 6 0"/>'
};
const colors={ink:'#252B36',blue:'#006CE8',muted:'#717A8B',white:'#FFFFFF',green:'#218564',orange:'#B87524'};
const directory='apps/mini/src/static/icons';await fs.mkdir(directory,{recursive:true});
for(const[name,body]of Object.entries(icons))for(const[tone,color]of Object.entries(colors)){
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
 await sharp(Buffer.from(svg)).resize(96,96).png({palette:true}).toFile(`${directory}/${name}-${tone}.png`);
}
console.log(`Generated ${Object.keys(icons).length*Object.keys(colors).length} local interface icons`);
