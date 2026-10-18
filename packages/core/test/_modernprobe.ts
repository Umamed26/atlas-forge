import { createDefaultDocument, createPipeline, assessWorldMetrics } from "../src/index";
const size = 1024;
const seed = 20261018;
const doc = createDefaultDocument({ seed, params: { gridSize: size } });
const t0 = performance.now();
const layers = createPipeline().generate({ document: doc, size });
const wall = performance.now() - t0;
const metrics = assessWorldMetrics(layers);
const sl = doc.params.seaLevel, span = 1 - sl;
// moisture: interior vs coastal (exclude high mountains)
const NX = [-1,1,0,0,-1,1,-1,1], NY = [0,0,-1,1,-1,-1,1,1];
function distToSea() {
  const n = size*size, dist = new Int32Array(n).fill(-1), q = new Int32Array(n);
  let h = 0, t = 0;
  for (let i=0;i<n;i++) if (layers.ocean[i]) {dist[i]=0; q[t++]=i;}
  while (h<t) { const c=q[h++]; const x=c%size, y=(c/size)|0;
    for (let k=0;k<8;k++){const nx=x+NX[k], ny=y+NY[k]; if(nx<0||ny<0||nx>=size||ny>=size)continue; const j=ny*size+nx; if(dist[j]<0){dist[j]=dist[c]+1;q[t++]=j;}}
  }
  return dist;
}
const dist = distToSea();
let coastM=0,coastN=0,deepM=0,deepN=0;
let snowLowLat: number[] = [], snowHighLat: number[] = [];
for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
  const i=y*size+x; if (layers.ocean[i]||layers.lake[i]) continue;
  const lat=Math.abs((y+0.5)/size-0.5)*2;
  const a=(layers.height[i]-sl)/span;
  if (layers.biome[i]===14) { if (lat<0.2) snowLowLat.push(a); if (lat>0.7) snowHighLat.push(a); }
  if (a>0.5) continue;
  if (dist[i]>=0 && dist[i]<=3) {coastM+=layers.moisture[i];coastN++;}
  if (dist[i]>=90) {deepM+=layers.moisture[i];deepN++;}
}
const minA = (arr: number[]) => arr.length ? Math.min(...arr) : NaN;
console.log(JSON.stringify({
  wall: Math.round(wall), total: Math.round(layers.stats.totalMs),
  stages: {t:Math.round(layers.stats.terrainMs),h:Math.round(layers.stats.hydrologyMs),c:Math.round(layers.stats.climateMs),b:Math.round(layers.stats.biomeMs),u:Math.round(layers.stats.humanMs)},
  land:+metrics.landFraction.toFixed(3), riverCells: metrics.riverCells, riverCount: metrics.riverCount,
  settlements: metrics.settlements, labels: metrics.labels, biomeKinds: metrics.biomeKinds,
  coastMoist: +(coastM/coastN).toFixed(3), deepMoist: +(deepM/deepN).toFixed(3),
  snowlineEqMinA: +minA(snowLowLat).toFixed(3), snowlinePolarMinA: +minA(snowHighLat).toFixed(3),
  order0: layers.riverOrder ? layers.riverOrder.reduce((a,b)=>a+b,0) : null,
}));
const counts = new Map<number, number>();
for (let i=0;i<layers.biome.length;i++) counts.set(layers.biome[i],(counts.get(layers.biome[i])??0)+1);
console.log([...counts.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${(100*v/(size*size)).toFixed(1)}%`).join(" "));
