import * as pc from './vendor/playcanvas.mjs';
import {CollisionWorld} from './collision.js';

const $=id=>document.getElementById(id),canvas=$('scene');
const KEY='ancestral-home-v1',RAD=Math.PI/180;
let app,camera,world,gsplat,metadata,ready=false,mode='fly',exploring=false;
let yaw=0,pitch=0,scale=.05,verified=false,eye=1.7,speed=1.4;
let measuring=false,measurement=[],distanceRaw=0,drag=null,moved=false,toastTimer;
let keys=new Set(),touchMoves=new Set(),fps=0,frameCount=0,elapsed=0,saveElapsed=0,errors=[];
let calibration=null,lastView=null;
const position=new pc.Vec3(),look=new pc.Vec3(),lineColor=new pc.Color(1,.78,.4);
const presets={entry:{pos:[-150,38,200],target:[40,62,-10]},court:{pos:[-160,38,65],target:[30,50,-35]},overview:{pos:[420,430,530],target:[10,55,0]}};
const STORAGE={get(){try{return JSON.parse(localStorage.getItem(KEY)||'{}')}catch{return{}}},set(value){try{localStorage.setItem(KEY,JSON.stringify(value))}catch{}}};
const saved=STORAGE.get();
if(Number.isFinite(saved.scale)&&saved.scale>=.00001&&saved.scale<=1000){scale=saved.scale;verified=saved.verified===true;calibration=saved.calibration||null;}
if(Number.isFinite(saved.eye)&&saved.eye>=1&&saved.eye<=2.1)eye=saved.eye;
if(Number.isFinite(saved.speed)&&saved.speed>=.5&&saved.speed<=3)speed=saved.speed;

function toast(text,ms=3500){$('toast').textContent=text;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),ms);}
function persist(){STORAGE.set({scale,verified,calibration,eye,speed,view:ready?{position:camera.getPosition().toArray(),yaw,pitch,mode}:saved.view});}
function loading(progress,text){$('loading-bar').style.width=`${progress}%`;$('loading-detail').textContent=text;}
function fail(error){console.error(error);errors.push(String(error));$('loading-title').textContent='空间暂时无法打开';$('loading-detail').textContent=String(error.message||error);$('retry').hidden=false;$('load-state').textContent='加载失败';}
function updateScaleUI(){
 $('scale-badge').textContent=verified?'已校准':'待校准';
 $('metric-status').textContent=verified?`实测校准 · 视高 ${eye.toFixed(2)} m`:'预览比例 · 未校准';
 $('scale-info').textContent=verified?`1 个原始单位 = ${scale.toPrecision(5)} 米。视高、步速和测距均使用此校准。`:`原始数据未记录长度单位。当前仅按 1 单位 = ${scale.toPrecision(3)} 米预览；输入实测距离后，视高和速度才对应真实米制空间。`;
 $('eye-height').value=eye;$('eye-value').textContent=`${eye.toFixed(2)} m`;
 $('speed').value=speed;$('speed-value').textContent=`${speed.toFixed(2)} m/s`;
}
function orient(){camera.setLocalEulerAngles(pitch,yaw,0);}
function focusAt(target){const p=camera.getPosition();const dx=target[0]-p.x,dy=target[1]-p.y,dz=target[2]-p.z;yaw=Math.atan2(-dx,-dz)/RAD;pitch=Math.atan2(dy,Math.hypot(dx,dz))/RAD;orient();}
function view(name){
 const v=presets[name];setMode('fly',false);camera.setPosition(...v.pos);focusAt(v.target);lastView=name;
 document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('selected',b.dataset.view===name));
 if(name!=='overview'&&exploring)setMode('walk',false);
 persist();
}
function snapToGround(){
 const p=camera.getPosition();const hit=world.ground(p.x,p.z,p.y+.4/scale,6/scale);
 if(!hit||Math.abs(hit.normal[1])<.55||world.blocked(p.x,p.z,hit.point[1],scale,eye))return false;
 camera.setPosition(p.x,hit.point[1]+eye/scale,p.z);return true;
}
function setMode(next,notify=true){
 if(!ready&&next==='walk')return;
 if(next==='walk'&&!snapToGround()){if(notify)toast('脚下没有可行走地面，请先在导航图中选择院落位置。');return false;}
 mode=next;document.body.dataset.mode=mode;
 $('walk-mode').classList.toggle('active',mode==='walk');$('fly-mode').classList.toggle('active',mode==='fly');
 $('mode-label').textContent=mode==='walk'?'步行漫游':'自由飞行';
 if(notify)toast(mode==='walk'?'已进入步行 · WASD 移动，拖动环顾':'自由飞行 · WASD 移动，Q / E 升降');
 return true;
}
function enter(){if(!ready)return;exploring=true;document.body.classList.add('exploring');const walking=setMode('walk',false);canvas.focus();toast(walking?'WASD 行走 · 拖动环顾 · 点击画面可锁定鼠标':'当前视点暂不能落地，可自由飞行或点击院落导航。',5000);}
function move(dt){
 const k=(...codes)=>codes.some(c=>keys.has(c));
 const f=(k('KeyW','ArrowUp')||touchMoves.has('forward')?1:0)-(k('KeyS','ArrowDown')||touchMoves.has('back')?1:0);
 const r=(k('KeyD','ArrowRight')||touchMoves.has('right')?1:0)-(k('KeyA','ArrowLeft')||touchMoves.has('left')?1:0);
 const u=mode==='fly'?((k('KeyE')||touchMoves.has('up')?1:0)-(k('KeyQ')||touchMoves.has('down')?1:0)):0;
 if(!f&&!r&&!u)return;
 if(!exploring){exploring=true;document.body.classList.add('exploring');}
 let x=-Math.sin(yaw*RAD)*f+Math.cos(yaw*RAD)*r;
 let z=-Math.cos(yaw*RAD)*f-Math.sin(yaw*RAD)*r;
 let y=u;
 if(mode==='fly'){x*=Math.cos(pitch*RAD);z*=Math.cos(pitch*RAD);y+=Math.sin(pitch*RAD)*f;}
 const norm=Math.hypot(x,y,z)||1;
 const distance=speed/scale*(k('ShiftLeft','ShiftRight')?2.5:1)*(mode==='fly'?2:1)*dt;
 const p=camera.getPosition();
 if(mode==='walk'){
  // Small substeps prevent crossing thin walls during a low frame-rate frame.
  let next=p.toArray();const steps=Math.max(1,Math.ceil(distance/(.12/scale)));
  for(let i=0;i<steps;i++)next=world.step(next,x/norm*distance/steps,z/norm*distance/steps,scale,eye);
  camera.setPosition(...next);
 }else camera.setPosition(p.x+x/norm*distance,p.y+y/norm*distance,p.z+z/norm*distance);
 lastView=null;document.querySelectorAll('[data-view]').forEach(b=>b.classList.remove('selected'));
}
function pointerLook(dx,dy){yaw-=dx*.16;pitch=Math.max(-85,Math.min(85,pitch-dy*.16));orient();}
function pick(clientX,clientY){
 const rect=canvas.getBoundingClientRect();
 const far=camera.camera.screenToWorld(clientX-rect.left,clientY-rect.top,camera.camera.farClip);
 const origin=camera.getPosition();const direction=far.sub(origin).normalize();
 const hit=world.ray(origin.toArray(),direction.toArray());
 if(!hit){toast('此处没有重建表面，请选取清晰的墙面或地面。');return;}
 measurement.push(hit.point);
 if(measurement.length===1){$('measure-label').textContent='已选 A 点 · 请选择第二个端点 B';toast('已选第一个端点');}
 if(measurement.length===2){
  distanceRaw=Math.hypot(...measurement[0].map((v,i)=>v-measurement[1][i]));
  if(distanceRaw<.01){measurement.pop();toast('两点过近，请选择更远的第二点。');return;}
  measuring=false;document.body.classList.remove('measuring');$('settings').hidden=false;$('measure-label').hidden=true;
  $('measure-info').textContent=`已选两点：${distanceRaw.toFixed(3)} 原始单位${verified?` / ${(distanceRaw*scale).toFixed(3)} 米`:''}。请输入实测米数。`;
  $('apply-scale').disabled=false;$('real-distance').focus();
 }
}
function drawMeasurement(){
 if(!measurement.length)return;
 for(const p of measurement){const n=.08/scale;app.drawLine(new pc.Vec3(p[0]-n,p[1],p[2]),new pc.Vec3(p[0]+n,p[1],p[2]),lineColor,false);app.drawLine(new pc.Vec3(p[0],p[1]-n,p[2]),new pc.Vec3(p[0],p[1]+n,p[2]),lineColor,false);}
 if(measurement.length===2)app.drawLine(new pc.Vec3(...measurement[0]),new pc.Vec3(...measurement[1]),lineColor,false);
}
const map=$('map'),ctx=map.getContext('2d');
function mapCoord(p){const [x0,y0,x1,y1]=metadata.mapBounds;return [(p[0]-x0)/(x1-x0)*map.width,(y1+p[2])/(y1-y0)*map.height];}
function drawMap(){
 if(!metadata||!camera)return;
 ctx.clearRect(0,0,map.width,map.height);
 const [x,y]=mapCoord(camera.getPosition().toArray());const a=yaw*RAD;
 ctx.save();ctx.translate(x,y);ctx.rotate(-a);ctx.fillStyle='#b48d4050';ctx.beginPath();ctx.moveTo(0,0);ctx.arc(0,0,40,-Math.PI*.68,-Math.PI*.32);ctx.closePath();ctx.fill();ctx.restore();
 ctx.fillStyle='#e3bd76';ctx.strokeStyle='#233d3e';ctx.lineWidth=3;ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.fill();ctx.stroke();
}
map.addEventListener('click',e=>{
 if(!ready)return;const rect=map.getBoundingClientRect();const [x0,y0,x1,y1]=metadata.mapBounds;
 const x=x0+(e.clientX-rect.left)/rect.width*(x1-x0),z=-(y1-(e.clientY-rect.top)/rect.height*(y1-y0));
 // Prefer the current storey; never blindly drop onto a roof from infinity.
 const p=camera.getPosition();const ceiling=mode==='walk'?p.y-eye/scale+.4/scale:45;
 const hit=world.ground(x,z,ceiling,1000);
 if(!hit||Math.abs(hit.normal[1])<.55||world.blocked(x,z,hit.point[1],scale,eye)){toast('该位置没有足够的站立空间，请选择开阔地面。');return;}
 camera.setPosition(x,hit.point[1]+eye/scale,z);exploring=true;document.body.classList.add('exploring');setMode('walk',false);persist();toast('已定位 · 拖动环顾四周');
});

canvas.addEventListener('pointerdown',e=>{if(!ready)return;canvas.focus();moved=false;if(!document.pointerLockElement){drag={x:e.clientX,y:e.clientY,id:e.pointerId};canvas.setPointerCapture(e.pointerId);}});
canvas.addEventListener('pointermove',e=>{
 if(!ready)return;
 if(document.pointerLockElement===canvas){pointerLook(e.movementX,e.movementY);return;}
 if(drag&&drag.id===e.pointerId){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>1)moved=true;pointerLook(dx,dy);drag.x=e.clientX;drag.y=e.clientY;}
});
canvas.addEventListener('pointerup',e=>{
 const wasMoved=moved;drag=null;
 if(!ready||wasMoved)return;
 if(measuring){pick(e.clientX,e.clientY);return;}
 if(exploring&&e.pointerType==='mouse'&&!document.pointerLockElement){try{canvas.requestPointerLock()?.catch(()=>toast('可直接拖动画面环顾'));}catch{toast('可直接拖动画面环顾');}}
});
canvas.addEventListener('pointercancel',()=>{drag=null;});
document.addEventListener('pointerlockchange',()=>{document.body.classList.toggle('locked',document.pointerLockElement===canvas);keys.clear();});
canvas.addEventListener('contextmenu',e=>e.preventDefault());
window.addEventListener('keydown',e=>{
 if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)||$('help').open)return;
 if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyQ','KeyE','ShiftLeft','ShiftRight'].includes(e.code)){e.preventDefault();keys.add(e.code);}
 if(e.code==='KeyH'&&ready)view('entry');
 if(e.code==='Escape'&&measuring){measuring=false;measurement=[];document.body.classList.remove('measuring');$('measure-label').hidden=true;$('settings').hidden=false;toast('已取消选点');}
});
window.addEventListener('keyup',e=>keys.delete(e.code));
window.addEventListener('blur',()=>{keys.clear();touchMoves.clear();drag=null;});
document.addEventListener('visibilitychange',()=>{keys.clear();touchMoves.clear();});
document.querySelectorAll('[data-move]').forEach(b=>{b.addEventListener('pointerdown',e=>{e.preventDefault();b.setPointerCapture(e.pointerId);touchMoves.add(b.dataset.move);});for(const event of ['pointerup','pointercancel','lostpointercapture'])b.addEventListener(event,()=>touchMoves.delete(b.dataset.move));});
$('enter').onclick=enter;
$('walk-mode').onclick=()=>{if(ready){exploring=true;document.body.classList.add('exploring');setMode('walk');}};
$('fly-mode').onclick=()=>{if(ready){exploring=true;document.body.classList.add('exploring');setMode('fly');}};
$('home').onclick=()=>{if(ready){view('entry');toast('已回到院前');}};
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{if(ready)view(b.dataset.view);});
$('settings-button').onclick=()=>{$('settings').hidden=!$('settings').hidden;keys.clear();document.exitPointerLock?.();};
$('close-settings').onclick=()=>$('settings').hidden=true;
$('map-toggle').onclick=()=>{$('map-body').hidden=!$('map-body').hidden;$('map-toggle').textContent=$('map-body').hidden?'+':'−';$('map-toggle').setAttribute('aria-label',$('map-body').hidden?'展开导航图':'收起导航图');};
$('help-button').onclick=()=>{document.exitPointerLock?.();keys.clear();$('help').showModal();};
$('close-help').onclick=()=>$('help').close();$('understood').onclick=()=>{$('help').close();if(ready)enter();};
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{toast('此浏览器暂不支持全屏，可放大浏览器窗口。');}};
$('retry').onclick=()=>location.reload();
$('eye-height').oninput=e=>{const previous=eye;eye=+e.target.value;if(ready&&mode==='walk'){const p=camera.getPosition();camera.setPosition(p.x,p.y+(eye-previous)/scale,p.z);}updateScaleUI();persist();};
$('speed').oninput=e=>{speed=+e.target.value;updateScaleUI();persist();};
$('fov').oninput=e=>{if(camera)camera.camera.fov=+e.target.value;$('fov-value').textContent=`${e.target.value}°`;};
function applyQuality(){if(!app||!gsplat)return;const q=$('quality').value;app.scene.gsplat.splatBudget={low:600000,balanced:1500000,high:3000000}[q];gsplat.gsplat.lodRangeMin={low:3,balanced:1,high:0}[q];app.graphicsDevice.maxPixelRatio=q==='high'?Math.min(window.devicePixelRatio,1.5):1;app.resizeCanvas();}
$('quality').onchange=()=>{applyQuality();toast('正在按新画质加载空间细节');};
$('calibrate').onclick=()=>{
 if(!ready)return;document.exitPointerLock?.();keys.clear();measuring=true;measurement=[];distanceRaw=0;$('apply-scale').disabled=true;
 $('settings').hidden=true;$('measure-label').hidden=false;$('measure-label').textContent='尺度校准 · 点击第一个端点 A · 拖动可转向 · Esc 取消';
 document.body.classList.add('measuring');document.body.classList.add('exploring');exploring=true;toast('请选取清晰的网格表面；推荐使用较长的已知距离。',5000);
};
function changeScale(next,isVerified){const p=camera?.getPosition();const foot=p?p.y-eye/scale:0;scale=next;verified=isVerified;if(p&&mode==='walk')camera.setPosition(p.x,foot+eye/scale,p.z);updateScaleUI();persist();}
$('apply-scale').onclick=()=>{
 const real=Number($('real-distance').value),ratio=real/distanceRaw;
 if(!Number.isFinite(real)||real<=0||distanceRaw<=0||ratio<.00001||ratio>1000){toast('请输入有效的实测距离（米）。');return;}
 calibration={points:measurement.map(p=>p.slice()),sourceDistance:distanceRaw,realDistance:real,date:new Date().toISOString()};
 changeScale(ratio,true);$('measure-info').textContent=`校准完成：两点距离 ${real.toFixed(3)} 米。已保存在此浏览器。`;toast('实测尺度已应用，视高与步速已同步。',5000);
};
$('reset-scale').onclick=()=>{calibration=null;measurement=[];changeScale(.05,false);$('real-distance').value='';$('measure-info').textContent='已恢复预览比例，尚未核准真实尺度。';$('apply-scale').disabled=true;distanceRaw=0;toast('已恢复预览比例 · 真实尺度待校准');};
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('export-calibration').onclick=()=>{download(new Blob([JSON.stringify({scene:'祖宅-20261007',sourceSplatCount:25077467,metersPerUnit:scale,verified,calibration},null,2)],{type:'application/json'}),'祖宅-尺度校准.json');toast('已导出尺度参数');};
$('screenshot').onclick=()=>{if(!ready)return;app.once('frameend',()=>canvas.toBlob(blob=>{if(blob){download(blob,'祖宅-漫游.png');toast('已保存场景截图');}else toast('截图失败，请重试');},'image/png'));app.renderNextFrame=true;};

async function init(){
 updateScaleUI();
 if(location.protocol==='file:')throw new Error('请运行“启动漫游.cmd”，通过本地 HTTP 地址打开此网页。');
 if(!canvas.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true}))throw new Error('浏览器需要开启硬件加速并支持 WebGL 2。');
 loading(10,'初始化高斯泼溅渲染器…');
 const device=await pc.createGraphicsDevice(canvas,{deviceTypes:['webgl2'],antialias:false,preserveDrawingBuffer:true,alpha:false});
 const options=new pc.AppOptions();options.graphicsDevice=device;
 options.componentSystems=[pc.CameraComponentSystem,pc.GSplatComponentSystem,pc.RenderComponentSystem];
 options.resourceHandlers=[pc.GSplatHandler,pc.TextureHandler];
 app=new pc.AppBase(canvas);app.init(options);
 app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);app.setCanvasResolution(pc.RESOLUTION_AUTO);device.maxPixelRatio=1;
 device.on('devicelost',()=>{keys.clear();$('load-state').textContent='显卡连接中断';toast('显卡连接中断，请重新加载页面。',15000);});
 window.addEventListener('resize',()=>app.resizeCanvas());
 camera=new pc.Entity('Visitor');camera.addComponent('camera',{fov:65,nearClip:.5,farClip:10000,clearColor:new pc.Color(.28,.34,.36),toneMapping:pc.TONEMAP_LINEAR});app.root.addChild(camera);
 view('entry');
 app.scene.gsplat.splatBudget=800000;app.scene.gsplat.splatBudgetMode=pc.GSPLAT_BUDGET_TARGET;
 app.scene.gsplat.lodUpdateDistance=4;app.scene.gsplat.lodUpdateAngle=25;app.scene.gsplat.lodBehindPenalty=3;app.scene.gsplat.radialSorting=true;
 app.on('update',dt=>{
  if(ready&&!$('help').open&&!document.hidden)move(Math.min(dt,.08));
  drawMeasurement();elapsed+=dt;frameCount++;saveElapsed+=dt;
  if(elapsed>.5){fps=Math.round(frameCount/elapsed);frameCount=0;elapsed=0;drawMap();
   const count=app.stats.frame.gsplats||0;
   if(ready){$('load-state').textContent=`空间已就绪 · ${(count/10000).toFixed(0)} 万点`;
    const p=camera.getPosition();$('diagnostics').textContent=`${fps} FPS · ${count.toLocaleString()} 个渲染点 · ${world.triangleCount.toLocaleString()} 个碰撞三角面 · 相机 ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} · ${errors.length} 个加载错误`;}
  }
  if(ready&&saveElapsed>3){saveElapsed=0;if(exploring)persist();}
 });app.start();
 const fetchChecked=async url=>{const r=await fetch(url);if(!r.ok)throw new Error(`数据读取失败：${url} (${r.status})`);return r;};
 const [meta,bin]=await Promise.all([(await fetchChecked('assets/scene.json')).json(),(await fetchChecked('assets/collision.bin')).arrayBuffer()]);
 metadata=meta;loading(35,'构建地面与墙体碰撞…');
 world=new CollisionWorld(new Float32Array(bin));
 loading(50,'加载首批高斯瓦片…');
 const asset=new pc.Asset('祖宅','gsplat',{url:'assets/splats/lod-meta.json'});
 app.assets.on('error',(error)=>{errors.push(String(error));$('load-state').textContent='部分数据加载失败';toast('部分空间数据加载失败，可刷新重试。');});
 await new Promise((resolve,reject)=>{asset.once('load',resolve);asset.once('error',reject);app.assets.add(asset);app.assets.load(asset);});
 gsplat=new pc.Entity('Ancestral home');gsplat.setEulerAngles(-90,0,0);gsplat.addComponent('gsplat',{asset});
 gsplat.gsplat.lodRangeMin=5;gsplat.gsplat.lodRangeMax=5;gsplat.gsplat.lodBaseDistance=150;gsplat.gsplat.lodMultiplier=2;
 app.root.addChild(gsplat);loading(70,'正在绘制空间，细节会逐步清晰…');
 let revealed=false;
 const reveal=()=>{if(revealed)return;revealed=true;ready=true;applyQuality();$('loading').classList.add('done');$('enter').disabled=false;$('enter').firstElementChild.textContent='走进祖宅';$('load-state').textContent='空间已就绪';loading(100,'空间已就绪');
  // Restore only a valid saved camera inside reasonable local coordinates.
  if(saved.view?.position?.length===3&&saved.view.position.every(v=>Number.isFinite(v)&&Math.abs(v)<10000)&&Number.isFinite(saved.view.yaw)&&Number.isFinite(saved.view.pitch)){
   camera.setPosition(...saved.view.position);yaw=saved.view.yaw;pitch=Math.max(-85,Math.min(85,saved.view.pitch));orient();mode='fly';setMode(saved.view.mode==='walk'?'walk':'fly',false);
  }
  if(new URLSearchParams(location.search).has('qa'))runQA();
 };
 app.systems.gsplat.on('frame:ready',(_camera,_layer,isReady,loadingCount)=>{if(isReady&&loadingCount===0&&(app.stats.frame.gsplats||0)>0)reveal();});
 const check=setInterval(()=>{const count=app.stats.frame.gsplats||0;if(count>0){reveal();clearInterval(check);}},800);
 setTimeout(()=>{if(!ready){clearInterval(check);fail(new Error('首批瓦片加载超时，请刷新重试或确认显卡硬件加速已启用。'));}},90000);
}

function runQA(){
 const results=[];
 const check=(name,condition)=>results.push(`${condition?'PASS':'FAIL'} ${name}`);
 check('高斯点实际渲染',(app.stats.frame.gsplats||0)>0);
 check('碰撞网格已构建',world.triangleCount>10000);
 const hit=world.ground(-150,200,45,1000);check('院前地面射线',!!hit);
 if(hit){const p=[-150,hit.point[1]+eye/scale,200],next=world.step(p,1,0,scale,eye);check('行走产生位移',Math.abs(next[0]-p[0])>.9);check('步行视高保持',Math.abs((next[1]-(world.ground(next[0],next[2],next[1],200)?.point[1]??-999))*scale-eye)<.02);}
 check('未知尺度未冒充实测',verified||$('metric-status').textContent.includes('未校准'));
 const pre=document.createElement('pre');pre.id='qa-results';pre.textContent=results.join('\n');pre.style.cssText='position:fixed;top:100px;left:25px;background:#132b25;padding:20px;z-index:50;font-size:12px;color:white';document.body.append(pre);
}
window.addEventListener('pagehide',()=>{if(ready)persist();});
init().catch(fail);
