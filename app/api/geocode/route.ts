import { NextRequest, NextResponse } from "next/server";
import { analyzeCatalogAddress, bestStreetMatch, normalizeText } from "@/lib/street-catalog";
import { locationByKey } from "@/lib/supported-locations";

type Point = { lat: number; lon: number };
type Result = {
  lat?: number; lon?: number; precision: "exact"|"parallel"|"street"|"missing";
  source: "georef"|"photon"|"overpass"|"none";
  reason: string; normalizedAddress: string; locality: string; corrections?: unknown[];
};

const ua = { "User-Agent": "RutaPostal/1.0 (open-source delivery planner)" };
async function fetchJson(url: string, init?: RequestInit, timeout=9000) {
  const ctrl = new AbortController(); const t=setTimeout(()=>ctrl.abort(),timeout);
  try { const r=await fetch(url,{...init,signal:ctrl.signal,headers:{...ua,...(init?.headers||{})}}); if(!r.ok) return null; return await r.json(); }
  catch { return null; } finally { clearTimeout(t); }
}

async function georef(address: string, locationKey: string): Promise<Point|null> {
  const loc=locationByKey(locationKey); const qs=new URLSearchParams({direccion:address,provincia:"Buenos Aires",departamento:loc.department,max:"1",campos:"completo"});
  if(loc.locality) qs.set("localidad_censal",loc.locality);
  const data=await fetchJson(`https://apis.datos.gob.ar/georef/api/direcciones?${qs}`);
  const hit=data?.direcciones?.[0]?.ubicacion;
  return Number.isFinite(hit?.lat)&&Number.isFinite(hit?.lon)?{lat:hit.lat,lon:hit.lon}:null;
}

async function photon(query: string, locationKey: string, limit=5) {
  const loc=locationByKey(locationKey); const place=loc.locality ?? loc.department;
  const qs=new URLSearchParams({q:`${query}, ${place}, Buenos Aires, Argentina`,limit:String(limit),lang:"es"});
  const data=await fetchJson(`https://photon.komoot.io/api/?${qs}`,undefined,10000);
  return (data?.features??[]).map((f:any)=>({lat:Number(f.geometry?.coordinates?.[1]),lon:Number(f.geometry?.coordinates?.[0]),name:String(f.properties?.name??""),street:String(f.properties?.street??""),city:String(f.properties?.city??f.properties?.locality??"")})).filter((p:any)=>Number.isFinite(p.lat)&&Number.isFinite(p.lon));
}

function distance(a:Point,b:Point){const y=(a.lat-b.lat)*111000,x=(a.lon-b.lon)*111000*Math.cos(a.lat*Math.PI/180);return Math.hypot(x,y);}
function bearing(a:Point,b:Point){return Math.atan2((b.lon-a.lon)*Math.cos((a.lat+b.lat)*Math.PI/360),b.lat-a.lat);}
function angleDiff(a:number,b:number){let d=Math.abs(a-b)%Math.PI;return Math.min(d,Math.PI-d);}
function projectOnSegment(p:Point,a:Point,b:Point):Point{
  const k=Math.cos(p.lat*Math.PI/180), ax=a.lon*k, ay=a.lat,bx=b.lon*k,by=b.lat,px=p.lon*k,py=p.lat;
  const dx=bx-ax,dy=by-ay,den=dx*dx+dy*dy||1; const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/den));
  return {lat:ay+t*dy,lon:(ax+t*dx)/k};
}

async function overpassWays(anchor:Point) {
  const query=`[out:json][timeout:8];way(around:500,${anchor.lat},${anchor.lon})["highway"]["name"];out tags geom;`;
  for(const endpoint of ["https://overpass-api.de/api/interpreter","https://overpass.private.coffee/api/interpreter","https://maps.mail.ru/osm/tools/overpass/api/interpreter"]){
    const data=await fetchJson(endpoint,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},body:new URLSearchParams({data:query})},12000);
    if(data?.elements?.length) return data.elements;
  }
  return [];
}

function nearestSegment(way:any,p:Point){let best:any=null;const g=way.geometry??[];for(let i=1;i<g.length;i++){const a={lat:g[i-1].lat,lon:g[i-1].lon},b={lat:g[i].lat,lon:g[i].lon},q=projectOnSegment(p,a,b),d=distance(p,q);if(!best||d<best.d)best={a,b,q,d};}return best;}

async function parallelFallback(street:string,height:number,locationKey:string):Promise<{point:Point;reason:string}|null>{
  const streetHits=await photon(street,locationKey,3); if(!streetHits[0]) return null; const anchor=streetHits[0];
  const ways=await overpassWays(anchor); if(!ways.length) return null;
  const targetNorm=normalizeText(street); const targetWays=ways.filter((w:any)=>normalizeText(w.tags?.name??"")===targetNorm || normalizeText(w.tags?.name??"").includes(targetNorm.replace(/^AV /,"")));
  const target=(targetWays.map((w:any)=>({w,s:nearestSegment(w,anchor)})).filter((x:any)=>x.s).sort((a:any,b:any)=>a.s.d-b.s.d)[0]); if(!target) return null;
  const targetAngle=bearing(target.s.a,target.s.b);
  const candidates=ways.map((w:any)=>({w,s:nearestSegment(w,anchor)})).filter((x:any)=>x.s&&normalizeText(x.w.tags?.name??"")!==targetNorm&&x.s.d<420&&angleDiff(targetAngle,bearing(x.s.a,x.s.b))<0.28).sort((a:any,b:any)=>a.s.d-b.s.d).slice(0,8);
  for(const c of candidates){const name=String(c.w.tags?.name??"");const match=bestStreetMatch(name,locationKey);const queryName=match?.street.name??name;const p=await georef(`${queryName} ${height}`,locationKey);if(!p)continue;const proj=nearestSegment(target.w,p);if(proj&&proj.d<650)return{point:proj.q,reason:`Altura ${height} estimada con la calle paralela ${name} y proyectada sobre ${street}.`};}
  return null;
}

async function resolveOne(raw:string,locationKey:string):Promise<Result>{
  const loc=locationByKey(locationKey); const analysis=analyzeCatalogAddress(raw,locationKey); const base=analysis.correctedAddress.replace(/\s+entre\s+.+$/i,"");
  const exact=await georef(base,locationKey); if(exact) return {...exact,precision:"exact",source:"georef",reason:"Domicilio localizado por Georef Argentina.",normalizedAddress:analysis.correctedAddress,locality:loc.label,corrections:analysis.corrections};
  const hits=await photon(base,locationKey,5); const hit=hits[0];
  if(hit && analysis.height){ const label=normalizeText(`${hit.street} ${hit.name}`); if(label.includes(String(analysis.height))) return {lat:hit.lat,lon:hit.lon,precision:"exact",source:"photon",reason:"Domicilio localizado por Photon/OpenStreetMap.",normalizedAddress:analysis.correctedAddress,locality:loc.label,corrections:analysis.corrections}; }
  if(analysis.height){const parallel=await parallelFallback(analysis.mainStreet,analysis.height,locationKey);if(parallel)return{...parallel.point,precision:"parallel",source:"overpass",reason:parallel.reason,normalizedAddress:analysis.correctedAddress,locality:loc.label,corrections:analysis.corrections};}
  const streetHits=await photon(analysis.mainStreet,locationKey,2); if(streetHits[0])return{lat:streetHits[0].lat,lon:streetHits[0].lon,precision:"street",source:"photon",reason:analysis.height?`No se encontró la altura ${analysis.height}; se marcó un punto aproximado sobre ${analysis.mainStreet}.`:`Se encontró la calle, pero la dirección no incluye una altura utilizable.`,normalizedAddress:analysis.correctedAddress,locality:loc.label,corrections:analysis.corrections};
  return{precision:"missing",source:"none",reason:"No se pudo localizar la calle ni una referencia suficientemente confiable.",normalizedAddress:analysis.correctedAddress,locality:loc.label,corrections:analysis.corrections};
}

export async function POST(request:NextRequest){
  const body=await request.json().catch(()=>null); const items=Array.isArray(body?.direcciones)?body.direcciones:[];
  if(!items.length) return NextResponse.json({error:"Faltan direcciones."},{status:400});
  const results=[] as Result[]; for(const item of items.slice(0,100)) results.push(await resolveOne(String(item.direccion??""),String(item.locationKey??"junin-6000")));
  return NextResponse.json({results});
}
