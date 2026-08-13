import * as THREE from "three";
import {createMech} from "./mech/model-registry.js";

const canvas=document.querySelector("#dialog-3d");
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true,powerPreference:"high-performance"});
renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=1.08;
renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;

const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(31,1,.1,80);
camera.position.set(10.8,5.6,13.2);
camera.lookAt(0,0,0);

scene.add(new THREE.HemisphereLight(0xcddcff,0x1a111f,1.55));
const key=new THREE.DirectionalLight(0xffffff,4.5);key.position.set(5,8,7);key.castShadow=true;key.shadow.mapSize.set(1024,1024);key.shadow.bias=-.0002;scene.add(key);
const fill=new THREE.DirectionalLight(0x8ba9ff,2.1);fill.position.set(-6,2,5);scene.add(fill);
const rim=new THREE.DirectionalLight(0xc064ff,3.2);rim.position.set(-4,5,-7);scene.add(rim);
const floor=new THREE.Mesh(new THREE.CircleGeometry(8,64),new THREE.MeshStandardMaterial({color:0x141119,roughness:.86,metalness:.05}));floor.rotation.x=-Math.PI/2;floor.position.y=-1.16;floor.receiveShadow=true;scene.add(floor);
const grid=new THREE.GridHelper(11,22,0x634579,0x2b2331);grid.position.y=-1.145;grid.material.transparent=true;grid.material.opacity=.2;scene.add(grid);

let model=null;

let yaw=.15,pitch=-.04,zoom=1,dragging=false,lastX=0,lastY=0,active=false;
function resize(){const rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;const dpr=Math.min(devicePixelRatio,2);renderer.setPixelRatio(dpr);renderer.setSize(rect.width,rect.height,false);camera.aspect=rect.width/rect.height;camera.updateProjectionMatrix()}
function setModel(index){if(model)scene.remove(model);model=createMech(index);scene.add(model);const bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3()),fit=4.9/Math.max(size.x,size.y,size.z);model.position.copy(center).multiplyScalar(-1);model.position.y+=.15;model.scale.setScalar(fit);model.userData.fit=fit;yaw=.15;pitch=-.04;zoom=1}
function animate(time){requestAnimationFrame(animate);if(!active||!model)return;model.rotation.y+=(yaw-model.rotation.y)*.12;model.rotation.x+=(pitch-model.rotation.x)*.12;model.scale.setScalar(model.userData.fit*zoom);model.traverse(o=>{if(o.userData.spin)o.rotation[o.userData.spin]=time*.004;if(o.userData.flap)o.rotation.z=o.userData.flap*Math.sin(time*.005)*.18});renderer.render(scene,camera)}
canvas.addEventListener("pointerdown",e=>{dragging=true;lastX=e.clientX;lastY=e.clientY;canvas.setPointerCapture(e.pointerId)});
canvas.addEventListener("pointermove",e=>{if(!dragging)return;yaw+=(e.clientX-lastX)*.008;pitch=THREE.MathUtils.clamp(pitch+(e.clientY-lastY)*.005,-.35,.28);lastX=e.clientX;lastY=e.clientY});
canvas.addEventListener("pointerup",()=>dragging=false);canvas.addEventListener("pointercancel",()=>dragging=false);
canvas.addEventListener("wheel",e=>{e.preventDefault();zoom=THREE.MathUtils.clamp(zoom-e.deltaY*.0008,.78,1.38)},{passive:false});
addEventListener("aerodiy:open-model",e=>{setModel(e.detail.index);active=true;setTimeout(resize,40)});addEventListener("aerodiy:resize-model",()=>setTimeout(resize,40));addEventListener("resize",resize);
document.querySelector("#project-dialog").addEventListener("close",()=>active=false);
animate(0);
