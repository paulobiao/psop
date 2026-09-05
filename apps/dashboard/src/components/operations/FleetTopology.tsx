import { Building2, CheckCircle2, Crosshair, Layers, Maximize2 } from 'lucide-react';
import { useMemo } from 'react';
import bg from '../../assets/topology-bg.jpg';
import cameraImg from '../../assets/camera.png';
import nvrImg from '../../assets/nvr.png';
import type { ConnectivityState, FleetDevice, GatewayManagedDevice } from '../../types';

interface Props { fleet: FleetDevice[]; managed: GatewayManagedDevice[]; onSelect: (deviceId: string) => void; }
interface Node { id:string; name:string; externalId:string; state:ConnectivityState; type:FleetDevice['device']['deviceType']; facts:string[]; }
interface Parent extends Node { children:Node[]; }
interface Site { id:string; name:string; code:string; parents:Parent[]; }
const labels:Record<ConnectivityState,string>={ONLINE:'Online',DEGRADED:'Degraded',OFFLINE:'Offline',UNKNOWN:'Unknown',NEVER_SEEN:'Never seen'};

function facts(t:FleetDevice['telemetry']):string[]{
  if(!t) return [];
  const n=(k:string)=>typeof t.details?.[k]==='number'?t.details[k] as number:null;
  const online=n('onlineChannelCount'), observed=n('observedChannelCount'), used=n('poeUsedPowerW'), total=n('poeTotalPowerW');
  const out:string[]=[];
  if(online!==null) out.push(observed===null?`${online} channels online`:`${online} / ${observed} Channels`); else if(t.channelNumber!==null) out.push(`Channel ${t.channelNumber}`);
  if(used!==null&&total!==null) out.push(`PoE ${used.toFixed(2)} / ${total.toFixed(0)} W`); else if(t.poePowerW!==null) out.push(`PoE ${t.poePowerW.toFixed(2)} W`);
  return out.slice(0,2);
}
function build(fleet:FleetDevice[],managed:GatewayManagedDevice[]):Site[]{
  const byId=new Map(fleet.map(x=>[x.device.id,x])); const sites=new Map<string,Site>(); const parents=new Map<string,Parent>();
  for(const item of managed){
    let site=sites.get(item.device.siteId); if(!site){site={id:item.device.siteId,name:item.device.siteName,code:item.device.siteCode,parents:[]};sites.set(site.id,site);}
    let parent=parents.get(item.gateway.id); if(!parent){const src=byId.get(item.gateway.id);parent={id:item.gateway.id,name:item.gateway.name,externalId:item.gateway.externalId,state:src?.connectivity.state??item.gateway.connectivity.state,type:item.gateway.deviceType,children:[],facts:facts(src?.telemetry??null)};parents.set(parent.id,parent);site.parents.push(parent);}
    parent.children.push({id:item.device.id,name:item.device.name,externalId:item.device.externalId,state:item.connectivity?.state??item.gateway.connectivity.state,type:item.device.deviceType,facts:facts(item.telemetry)});
  }
  for(const item of fleet) if(!sites.has(item.device.siteId)) sites.set(item.device.siteId,{id:item.device.siteId,name:item.device.siteName,code:item.device.siteCode,parents:[]});
  return [...sites.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
function Dot({state,pulse=false}:{state:ConnectivityState;pulse?:boolean}){return <span className={`lovable-dot lovable-dot--${state.toLowerCase()}${pulse?' is-pulsing':''}`} />;}
function bestParent(site:Site){return site.parents.slice().sort((a,b)=>Number(b.type==='RECORDER')-Number(a.type==='RECORDER')||b.children.length-a.children.length)[0]??null;}

export default function FleetTopology({fleet,managed,onSelect}:Props){
  const sites=useMemo(()=>build(fleet,managed),[fleet,managed]); if(!sites.length)return null;
  const site=sites[0]; const parent=bestParent(site); const cameras=(parent?.children.filter(c=>c.type==='CAMERA').slice(0,3)??[]); const children=cameras.length?cameras:(parent?.children.slice(0,3)??[]);
  const healthy=fleet.filter(x=>x.connectivity.state==='ONLINE').length; const nominal=fleet.length>0&&healthy===fleet.length;
  return <section className="fleet-topology lovable-topology" aria-labelledby="fleet-topology-title">
    <img className="lovable-topology__bg" src={bg} alt="" aria-hidden="true" />
    <div className="lovable-topology__shade" />
    <header className="fleet-topology__header lovable-topology__header">
      <div className="lovable-topology__view"><span className="eyebrow">Fleet topology</span><select defaultValue="health" aria-label="Topology view"><option value="health">Health view</option><option value="power">Power view</option><option value="protocol">Protocol view</option></select></div>
      <div className={`lovable-topology__health ${nominal?'is-nominal':'is-attention'}`}><CheckCircle2 size={18}/><span><strong>{fleet.length} Devices</strong><small>{nominal?'All systems nominal':`${healthy} online · attention required`}</small></span></div>
    </header>
    <div className="lovable-topology__legend">{(['ONLINE','DEGRADED','OFFLINE','UNKNOWN'] as ConnectivityState[]).map(s=><span key={s}><Dot state={s}/>{labels[s]}</span>)}</div>
    <div className="lovable-topology__tools">{[Crosshair,Layers,Maximize2].map((Icon,i)=><button type="button" key={i} aria-label={['Center view','Layers','Fullscreen'][i]}><Icon size={17}/></button>)}</div>
    <div className="lovable-topology__scene">
      <div className="lovable-topology__brand"><strong>PSOP Observability</strong><small>Secure &amp; Encrypted</small></div>
      <div className="lovable-site"><Building2 size={21}/><span><small>Site</small><strong>{site.name}</strong><em>{site.code}</em></span></div>
      <span className="lovable-link lovable-link--one" />
      {parent&&<button className="lovable-nvr" type="button" onClick={()=>onSelect(parent.id)}><img src={nvrImg} alt=""/><span><strong>{parent.name}</strong><em><Dot state={parent.state} pulse/>{labels[parent.state]}</em><small>{parent.facts.join(' · ')||parent.externalId}</small></span></button>}
      <span className="lovable-link lovable-link--two" />
      <div className="lovable-cameras">{children.map(child=><button key={child.id} type="button" onClick={()=>onSelect(child.id)}><img src={cameraImg} alt=""/><span><strong>{child.name}</strong><em><Dot state={child.state} pulse/>{labels[child.state]}</em><small>{child.facts.join(' · ')||child.externalId}</small></span></button>)}</div>
    </div>
  </section>;
}
