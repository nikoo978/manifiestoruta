export type ManifestRow = {
  packageNo: number;
  shipmentCode: string;
  recipient: string;
  address: string;
  city: string;
  postalCode: string;
  locationKey: string;
};
export type ManifestParseResult = { manifestNumber?: string; date?: string; expectedCount?: number; rows: ManifestRow[]; warnings: string[] };

type Item = { text:string; x:number; y:number };
function cleanSpaces(v:string){return v.replace(/\s+/g," ").trim();}
function cleanAddress(v:string){
  return cleanSpaces(v)
    .replace(/\s+OBS\d*.*$/i,"")
    .replace(/\s+CONTACTO:.*$/i,"")
    .replace(/\s+\d{12,}(?:-\d+)?\s*---.*$/i,"")
    .replace(/\s+X\s*-\s*X.*$/i,"")
    .replace(/\s+-\s+(\d+)\s+-\s+-$/," $1")
    .replace(/\s+0$/," ")
    .trim();
}
function keyFor(city:string,postal:string){
  const n=city.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
  if(n.includes("baigor")) return "baigorrita-6013";
  if(n.includes("toldos") || (n.includes("viamonte")&&postal==="6015")) return "los-toldos-6015";
  if(n.includes("ascen")) return "ascension-6003";
  if(n.includes("ferre")) return "ferre-6027";
  if(n.includes("junin")) return "junin-6000";
  return postal==="6013"?"baigorrita-6013":postal==="6015"?"los-toldos-6015":"junin-6000";
}

export async function parseManifestPdf(file:File):Promise<ManifestParseResult>{
  const importExternal = new Function("url", "return import(url)") as (url: string) => Promise<any>;
  const pdfjs:any=await importExternal("https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc=`https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.worker.min.mjs`;
  const data=new Uint8Array(await file.arrayBuffer()); const pdf=await pdfjs.getDocument({data}).promise;
  const pages:Item[][]=[]; const allText:string[]=[];
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p); const content=await page.getTextContent(); const items:Item[]=[];
    for(const raw of content.items){if(!raw?.str)continue;const text=cleanSpaces(raw.str);if(!text)continue;const x=Number(raw.transform?.[4]??0),y=Number(raw.transform?.[5]??0);items.push({text,x,y});allText.push(text);}
    pages.push(items);
  }
  const joined=allText.join(" "); const manifestNumber=joined.match(/N[°º]?\s*Manifiesto\s*:?\s*(\d{8,})/i)?.[1] ?? joined.match(/\b(\d{12})\b/)?.[1];
  const date=joined.match(/FECHA\s+MANIFIESTO\s*:?\s*(\d{2}-\d{2}-\d{4})/i)?.[1];
  const expectedCount=Number(joined.match(/Cantidad\s+de\s+envios\s*:?\s*(\d+)/i)?.[1]??0)||undefined;
  const rows:ManifestRow[]=[];
  for(const items of pages){
    const codes=items.filter(i=>i.x<330 && /[A-Z0-9][A-Z0-9-]{8,}/i.test(i.text) && /PQ/i.test(i.text)).sort((a,b)=>b.y-a.y);
    for(let idx=0;idx<codes.length;idx++){
      const code=codes[idx]; const lower=codes[idx+1]?.y ?? 35;
      const dest=items.filter(i=>i.x>=330&&i.x<690&&i.y<=code.y+14&&i.y>lower+4).sort((a,b)=>Math.abs(a.y-b.y)<2?a.x-b.x:b.y-a.y);
      const lines: Array<{y:number;text:string}> = [];
      for(const item of dest){const existing=lines.find(l=>Math.abs(l.y-item.y)<2);if(existing)existing.text=cleanSpaces(`${existing.text} ${item.text}`);else lines.push({y:item.y,text:item.text});}
      lines.sort((a,b)=>b.y-a.y); const texts=lines.map(l=>l.text).filter(t=>!/^APELLIDO y DNI/i.test(t)&&!/FIRMAR DOCUMENTO/i.test(t)&&!/DE PORTAGUIA/i.test(t));
      const locIndex=texts.findIndex(t=>/\b\d{4}\b/.test(t)&&/Buenos Aires/i.test(t)); if(locIndex<1)continue;
      const loc=texts[locIndex]; const postal=loc.match(/\b(\d{4})\b/)?.[1]??""; const city=cleanSpaces(loc.replace(/\b\d{4}\b/g,"").replace(/Buenos Aires/ig,"").replace(/,+/g," "));
      const recipient=texts[0]??""; const addrParts=texts.slice(1,locIndex); const address=cleanAddress(addrParts.join(" ")); if(!address)continue;
      rows.push({packageNo:rows.length+1,shipmentCode:code.text,recipient,address,city,postalCode:postal,locationKey:keyFor(city,postal)});
    }
  }
  const warnings:string[]=[]; if(expectedCount&&rows.length!==expectedCount)warnings.push(`El manifiesto indica ${expectedCount} envíos y se pudieron leer ${rows.length}.`);
  if(!rows.length)warnings.push("No se reconocieron filas de envío. Verificá que sea el formato de manifiesto esperado.");
  return{manifestNumber,date,expectedCount,rows,warnings};
}
