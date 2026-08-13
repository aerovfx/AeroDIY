import * as THREE from "three";

const paint = new THREE.MeshPhysicalMaterial({color:0xb8bec4,roughness:.4,metalness:.08,clearcoat:.32,clearcoatRoughness:.48});
const panel = new THREE.MeshStandardMaterial({color:0x899198,roughness:.48,metalness:.18});
const dark = new THREE.MeshStandardMaterial({color:0x20262b,roughness:.34,metalness:.62});
const rubber = new THREE.MeshStandardMaterial({color:0x111315,roughness:.92});
const glass = new THREE.MeshPhysicalMaterial({color:0x14232c,roughness:.08,metalness:.18,clearcoat:1,clearcoatRoughness:.06});
const red = new THREE.MeshStandardMaterial({color:0xff203b,emissive:0xff1028,emissiveIntensity:3,toneMapped:false});
const green = new THREE.MeshStandardMaterial({color:0x26ff9a,emissive:0x12d875,emissiveIntensity:2,toneMapped:false});

function mesh(geometry, material=paint, name="part") {
  const value=new THREE.Mesh(geometry,material); value.name=name; value.castShadow=true; value.receiveShadow=true; return value;
}
function group(root,name){const value=new THREE.Group();value.name=name;root.add(value);return value}
function taperedPanel(span,rootChord,tipChord,thickness,sweep=0){
  const shape=new THREE.Shape();
  shape.moveTo(0,rootChord*.5); shape.lineTo(span,sweep+tipChord*.5);
  shape.lineTo(span,sweep-tipChord*.5); shape.lineTo(0,-rootChord*.5); shape.closePath();
  const geometry=new THREE.ExtrudeGeometry(shape,{depth:thickness,bevelEnabled:true,bevelSegments:2,bevelSize:Math.min(.025,thickness*.3),bevelThickness:Math.min(.018,thickness*.22),curveSegments:2});
  geometry.translate(0,0,-thickness*.5); return geometry;
}
function strutBetween(a,b,r=.025,material=panel,name="strut"){
  const d=b.clone().sub(a),value=mesh(new THREE.CylinderGeometry(r,r,d.length(),10),material,name);
  value.position.copy(a).add(b).multiplyScalar(.5); value.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),d.normalize()); return value;
}
function addPanelLines(parent){
  const lineMat=new THREE.MeshBasicMaterial({color:0x606970,transparent:true,opacity:.62});
  [-1.15,-.35,.52,1.35].forEach((z,i)=>{const ring=mesh(new THREE.TorusGeometry(.34-i*.018,.007,6,40),lineMat,`fuselage-seam-${i}`);ring.rotation.x=Math.PI/2;ring.position.z=z;ring.scale.y=.82;parent.add(ring)});
  const hatch=mesh(new THREE.BoxGeometry(.72,.012,.42),lineMat,"payload-hatch-seam");hatch.position.set(0,-.49,.15);parent.add(hatch);
}
function buildNacelle(side){
  const nacelle=new THREE.Group();nacelle.name=`${side<0?"port":"starboard"}-engine-nacelle`;nacelle.position.set(side*1.32,-.22,-.05);
  const shell=mesh(new THREE.CapsuleGeometry(.25,.86,8,24),paint,"engine-shell");shell.rotation.x=Math.PI/2;nacelle.add(shell);
  const inlet=mesh(new THREE.TorusGeometry(.247,.035,10,36),panel,"engine-inlet-lip");inlet.position.z=.46;nacelle.add(inlet);
  const fan=group(nacelle,"turbine-fan-pivot");fan.position.z=.445;
  fan.add(mesh(new THREE.CylinderGeometry(.068,.068,.055,20),dark,"fan-hub")); fan.children[0].rotation.x=Math.PI/2;
  for(let i=0;i<14;i++){const blade=mesh(new THREE.BoxGeometry(.028,.145,.018),dark,`fan-blade-${i}`);blade.position.set(Math.cos(i*Math.PI/7)*.12,Math.sin(i*Math.PI/7)*.12,0);blade.rotation.z=i*Math.PI/7+.45;fan.add(blade)}
  const exhaust=mesh(new THREE.CylinderGeometry(.18,.22,.22,24,1,true),dark,"exhaust");exhaust.rotation.x=Math.PI/2;exhaust.position.z=-.51;nacelle.add(exhaust);
  return nacelle;
}
function buildGear(root){
  const gear=group(root,"landing-gear");
  [[0,-.45,.88,0,-1.05,.62],[-.62,-.27,-.2,-.78,-1.04,-.38],[.62,-.27,-.2,.78,-1.04,-.38]].forEach((v,i)=>{
    const a=new THREE.Vector3(v[0],v[1],v[2]),b=new THREE.Vector3(v[3],v[4],v[5]);gear.add(strutBetween(a,b,.035,panel,`gear-strut-${i}`));
    const wheel=mesh(new THREE.TorusGeometry(.13,.052,10,24),rubber,`wheel-${i}`);wheel.position.copy(b);wheel.rotation.y=Math.PI/2;gear.add(wheel);
  });
}

export function createLongRangeUAV(){
  const root=new THREE.Group();root.name="Long-Range-UAV";
  root.userData={assetType:"reference-derived-mech",reference:"long-range-uav-visual.png",approximation:"single-view; hidden geometry inferred",explodable:true};

  const fuselage=group(root,"fuselage-assembly");
  const profile=[[-2.35,.05],[-2.22,.18],[-1.95,.34],[-1.35,.48],[-.55,.5],[.35,.47],[1.25,.34],[2.05,.16],[2.32,.04]].map(([y,x])=>new THREE.Vector2(x,y));
  const body=mesh(new THREE.LatheGeometry(profile,48),paint,"fuselage-shell");body.rotation.x=Math.PI/2;body.scale.y=.82;fuselage.add(body);addPanelLines(fuselage);
  const belly=mesh(new THREE.BoxGeometry(.72,.36,1.2),panel,"ventral-payload-bay");belly.position.set(0,-.43,.18);belly.geometry.translate(0,0,0);fuselage.add(belly);

  const wing=group(root,"main-wing-assembly");wing.position.set(0,.1,.12);
  for(const side of [-1,1]){const panelMesh=mesh(taperedPanel(3.55,1.08,.31,.095,-.28),paint,`${side<0?"port":"starboard"}-wing`);panelMesh.scale.x=side;panelMesh.rotation.x=-Math.PI/2;wing.add(panelMesh);
    const seam=mesh(new THREE.BoxGeometry(1.25,.012,.018),dark,`${side<0?"port":"starboard"}-aileron-seam`);seam.position.set(side*2.68,.055,-.26);seam.rotation.y=side*.08;wing.add(seam);
    const lamp=mesh(new THREE.SphereGeometry(.045,12,8),side<0?red:green,`${side<0?"red":"green"}-navigation-light`);lamp.position.set(side*3.53,.02,-.27);wing.add(lamp)}

  const tail=group(root,"v-tail-assembly");tail.position.z=-1.78;tail.position.y=.18;
  for(const side of [-1,1]){const fin=mesh(taperedPanel(1.15,.62,.22,.075,.05),paint,`${side<0?"port":"starboard"}-tail-plane`);fin.rotation.set(-Math.PI/2,side*.22,side*.82);fin.position.x=side*.08;tail.add(fin)}

  for(const side of [-1,1])root.add(buildNacelle(side));
  const dorsal=group(root,"dorsal-engine-pod");dorsal.position.set(0,.45,-1.15);
  const dorsalShell=mesh(new THREE.CapsuleGeometry(.2,.55,7,20),paint,"dorsal-pod-shell");dorsalShell.rotation.x=Math.PI/2;dorsal.add(dorsalShell);
  const dorsalInlet=mesh(new THREE.TorusGeometry(.18,.03,8,28),dark,"dorsal-inlet");dorsalInlet.position.z=.3;dorsal.add(dorsalInlet);

  const sensor=group(root,"eo-ir-gimbal-pivot");sensor.position.set(0,-.42,1.75);
  sensor.add(mesh(new THREE.SphereGeometry(.25,28,18),panel,"gimbal-shell"));
  const lens=mesh(new THREE.CylinderGeometry(.105,.105,.035,24),glass,"eo-ir-lens");lens.rotation.x=Math.PI/2;lens.position.set(.1,-.025,.22);sensor.add(lens);
  const smallLens=mesh(new THREE.CylinderGeometry(.065,.065,.036,20),glass,"secondary-lens");smallLens.rotation.x=Math.PI/2;smallLens.position.set(-.105,-.07,.22);sensor.add(smallLens);
  buildGear(root);

  const antenna=mesh(new THREE.CylinderGeometry(.025,.035,.27,10),panel,"gps-antenna");antenna.position.set(-.12,.5,-.25);root.add(antenna);
  const cap=mesh(new THREE.CylinderGeometry(.1,.12,.035,20),paint,"gps-cap");cap.position.set(-.12,.65,-.25);root.add(cap);
  const pitot=mesh(new THREE.CylinderGeometry(.009,.015,.54,8),dark,"pitot-tube");pitot.rotation.x=Math.PI/2;pitot.position.set(.15,-.08,2.5);root.add(pitot);

  root.traverse(o=>{if(o.isMesh)o.userData.partName=o.name});
  return root;
}
