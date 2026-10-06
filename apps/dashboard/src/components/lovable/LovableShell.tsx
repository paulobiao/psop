import { Activity, AlertTriangle, ArrowUpDown, BellRing, Boxes, Building2, Camera, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Database, Gauge, HardDrive, History, KeyRound, Layers, Maximize2, MoreVertical, Network, RefreshCw, Search, Server, ShieldAlert, ShieldCheck, SlidersHorizontal, Sparkles, Users, WifiOff, Crosshair } from 'lucide-react';
import { useMemo } from 'react';
import logo from '../../assets/psop-logo.png';
import bg from '../../assets/topology-bg.jpg';
import cameraImg from '../../assets/camera.png';
import nvrImg from '../../assets/nvr.png';
import type { ActiveAlert, ConnectivityEvent, ConnectivityState, FleetDevice, GatewayManagedDevice, OperationsSummary, OperationalIncident } from '../../types';

export type FleetStateFilter = ConnectivityState | 'ALL';
export type FleetSort = 'STATE' | 'NAME' | 'SITE' | 'HEARTBEAT';
export interface NavActions { alerts:()=>void; incidents:()=>void; agents:()=>void; sites:()=>void; inventory:()=>void; sessions:()=>void; audit:()=>void; users:()=>void; notifications:()=>void }
const tone:Record<ConnectivityState,string>={ONLINE:'text-online',DEGRADED:'text-degraded',OFFLINE:'text-offline',UNKNOWN:'text-unknown',NEVER_SEEN:'text-unknown'};
const stateName:Record<ConnectivityState,string>={ONLINE:'Online',DEGRADED:'Degraded',OFFLINE:'Offline',UNKNOWN:'Unknown',NEVER_SEEN:'Never seen'};
const fmt=(v:string|null)=>v?new Intl.DateTimeFormat('en-US',{month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(v)):'Never';
const age=(s:number|null)=>s===null?'No heartbeat':s<60?`${s}s ago`:s<3600?`${Math.floor(s/60)}m ago`:s<86400?`${Math.floor(s/3600)}h ago`:`${Math.floor(s/86400)}d ago`;
function Dot({state,pulse=false}:{state:ConnectivityState;pulse?:boolean}){const c=state==='ONLINE'?'bg-online':state==='DEGRADED'?'bg-degraded':state==='OFFLINE'?'bg-offline':'bg-unknown';return <span className="relative inline-flex size-2">{pulse&&<span className={`absolute inset-0 animate-ping rounded-full opacity-50 ${c}`}/>}<span className={`relative size-2 rounded-full ${c}`}/></span>}
function Pill({state}:{state:ConnectivityState}){return <span className={`inline-flex items-center gap-2 rounded-full border border-border/70 bg-surface-2/70 px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${tone[state]}`}><Dot state={state} pulse={state==='ONLINE'}/>{stateName[state]}</span>}
function DeviceIcon({type}:{type:FleetDevice['device']['deviceType']}){return type==='CAMERA'?<Camera size={15}/>:type==='RECORDER'?<HardDrive size={15}/>:type==='GATEWAY'?<Network size={15}/>:<Server size={15}/>}

export function Sidebar({role,userName,alertCount,actions}:{role:'ADMIN'|'OPERATOR'|'VIEWER';userName:string;alertCount:number;actions:NavActions}){
 const groups=[['Operations',[['Overview',Gauge,null],['Alerts',ShieldAlert,actions.alerts],['Incidents',ShieldCheck,actions.incidents],['Agents',Network,actions.agents]]],['Assets',[['Sites',Building2,actions.sites],['Inventory',Boxes,actions.inventory]]],...(role==='ADMIN'?[['Administration',[['Users',Users,actions.users],['Sessions',KeyRound,actions.sessions],['Audit',History,actions.audit],['Notifications',BellRing,actions.notifications]]]]:[])] as any[];
 return <aside className="hidden w-[232px] shrink-0 flex-col border-r border-border/70 bg-[color:var(--sidebar)]/80 px-4 py-6 backdrop-blur lg:flex"><div className="flex items-center gap-3 px-1"><img src={logo} className="h-16 w-16 shrink-0 object-contain"/><div><h1 className="text-2xl leading-none font-bold tracking-[.12em]">PSOP</h1><p className="mt-1 text-[.6rem] tracking-[.22em] text-muted-foreground uppercase">Security observability</p></div></div><nav className="mt-9 flex-1 space-y-7 overflow-y-auto">{groups.map(([label,items])=><div key={label}><p className="label-caps px-2">{label}</p><ul className="mt-3 space-y-1">{items.map(([name,Icon,action]:any)=><li key={name}><button type="button" onClick={action||undefined} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${name==='Overview'?'glow-ring bg-primary/12 text-primary':'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}><Icon size={17}/><span className="flex-1 text-left">{name}</span>{name==='Alerts'&&alertCount>0?<span className="rounded-full bg-critical/20 px-2 text-xs font-semibold text-critical">{alertCount}</span>:null}</button></li>)}</ul></div>)}</nav><div className="panel mt-6 p-3"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-full bg-primary/15 text-sm font-bold text-primary">{userName.slice(0,2).toUpperCase()}</span><div className="min-w-0"><p className="truncate text-sm font-semibold">{userName}</p><p className="text-xs text-muted-foreground">{role==='ADMIN'?'Administrator':role==='OPERATOR'?'Operator':'Viewer'}</p></div></div></div><button className="mt-4 flex items-center gap-2 px-2 text-xs tracking-[.16em] text-muted-foreground uppercase"><ChevronLeft size={14}/> Collapse</button></aside>
}

export function Topbar({summary,siteName,siteCode,generatedAt,healthLabel,healthTone,refreshing,evaluating,canEvaluate,onRefresh,onEvaluate}:{summary:OperationsSummary;siteName:string;siteCode:string;generatedAt:string;healthLabel:string;healthTone:'connecting'|'critical'|'warning'|'healthy';refreshing:boolean;evaluating:boolean;canEvaluate:boolean;onRefresh:()=>void;onEvaluate:()=>void}){
 const st=healthTone==='critical'?'OFFLINE':healthTone==='warning'?'DEGRADED':'ONLINE';
 return <header className="flex flex-wrap items-center justify-between gap-6 border-b border-border/70 px-6 py-5"><div><h2 className="text-2xl font-semibold tracking-[.14em] uppercase">Security operations</h2><div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground"><Building2 size={15} className="text-primary"/><span className="font-semibold text-foreground">{siteName}</span><ChevronRight size={14}/><span>Site ID: {siteCode}</span></div></div><div className="flex flex-wrap items-center gap-6"><div className="text-right"><p className="label-caps">Fleet condition</p><p className={`flex items-center gap-2 text-sm font-semibold ${tone[st]}`}><Dot state={st} pulse/>{healthLabel}</p></div><div className="hidden items-center gap-5 border-l border-border/70 pl-6 md:flex">{[[Building2,'Sites',summary.sites],[Layers,'Monitored',summary.cameras],[Network,'Managed',summary.gatewayManaged]].map(([Icon,label,value]:any)=><div key={label} className="flex items-center gap-2"><span className="grid size-9 place-items-center rounded-lg bg-primary/12 text-primary"><Icon size={16}/></span><div><p className="label-caps">{label}</p><p className="text-lg leading-none font-semibold">{value}</p></div></div>)}</div><p className="hidden text-sm text-muted-foreground xl:block">{fmt(generatedAt)}</p><div className="flex items-center gap-2">{canEvaluate&&<button onClick={onEvaluate} disabled={evaluating} className="inline-flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3.5 py-2 text-sm font-semibold text-primary hover:bg-primary/20"><Sparkles size={16}/>{evaluating?'Evaluating…':'Evaluate'}</button>}<button onClick={onRefresh} disabled={refreshing} className="inline-flex items-center gap-2 rounded-lg border border-border/70 bg-surface-2/70 px-3.5 py-2 text-sm font-semibold hover:border-primary/40 hover:text-primary"><RefreshCw size={16} className={refreshing?'animate-spin':''}/>Refresh</button></div></div></header>
}

export function Priorities({summary,selected,onSelect,onAlerts}:{summary:OperationsSummary;selected:FleetStateFilter;onSelect:(s:ConnectivityState)=>void;onAlerts:()=>void}){const items=[{key:'OFFLINE' as const,label:'Offline',value:summary.offline,caption:'Heartbeat overdue',Icon:WifiOff,c:'text-offline from-offline/18'},{key:'DEGRADED' as const,label:'Degraded',value:summary.degraded,caption:'Reporting with warnings',Icon:AlertTriangle,c:'text-degraded from-degraded/18'},{key:null,label:'Active alerts',value:summary.activeAlerts,caption:`${summary.criticalAlerts} critical`,Icon:ShieldAlert,c:'text-critical from-critical/18'},{key:'UNKNOWN' as const,label:'Needs verification',value:summary.unknown+summary.neverSeen,caption:`${summary.unknown} unknown · ${summary.neverSeen} unseen`,Icon:Database,c:'text-unknown from-unknown/18'}];return <section className="panel p-5"><div className="flex flex-wrap items-center justify-between gap-2"><span className="label-caps">Operational priorities</span><p className="text-xs text-muted-foreground">Select a condition to focus the fleet</p></div><div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{items.map(({key,label,value,caption,Icon,c})=><button key={label} onClick={()=>key?onSelect(key):onAlerts()} className={`group relative overflow-hidden rounded-xl border border-border/70 bg-gradient-to-br to-transparent p-4 text-left transition-all hover:-translate-y-.5 ${c} ${key&&selected===key?'glow-ring':''}`}><div className="flex items-start justify-between gap-3"><span className="grid size-11 shrink-0 place-items-center rounded-xl bg-current/12"><Icon size={20}/></span><div className="min-w-0 flex-1"><p className="text-[.68rem] font-semibold tracking-[.16em] uppercase">{label}</p><p className="mt-1 text-4xl leading-none font-bold text-foreground">{value}</p><p className="mt-2 text-xs text-muted-foreground">{caption}</p></div></div><svg viewBox="0 0 100 24" className="absolute right-3 bottom-3 h-6 w-24 opacity-55"><path d="M0,19 L12,13 L24,17 L36,8 L48,15 L60,10 L72,16 L84,6 L100,12" fill="none" stroke="currentColor" strokeWidth="1.4"/></svg></button>)}</div></section>}

function facts(t:FleetDevice['telemetry']){if(!t)return '';const d=t.details;const n=(k:string)=>typeof d?.[k]==='number'?d[k] as number:null;const online=n('onlineChannelCount'),obs=n('observedChannelCount'),used=n('poeUsedPowerW'),total=n('poeTotalPowerW');if(online!==null)return `${obs===null?online:`${online} / ${obs}`} Channels${used!==null&&total!==null?` · PoE ${used.toFixed(2)} / ${total.toFixed(0)} W`:''}`;return `${t.channelNumber!==null?`Channel ${t.channelNumber}`:''}${t.poePowerW!==null?` · PoE ${t.poePowerW.toFixed(2)} W`:''}`.trim()}
export function Topology({fleet,managed,onSelect}:{fleet:FleetDevice[];managed:GatewayManagedDevice[];onSelect:(id:string)=>void}){
 const site=fleet[0]?.device;
 const online=fleet.filter(x=>x.connectivity.state==='ONLINE').length;

 const groups=useMemo(()=>{
   const map=new Map<string,{
     gateway:GatewayManagedDevice['gateway'];
     fleetDevice:FleetDevice|undefined;
     children:GatewayManagedDevice[];
   }>();

   for(const item of managed){
     const existing=map.get(item.gateway.id);

     if(existing){
       existing.children.push(item);
       continue;
     }

     map.set(item.gateway.id,{
       gateway:item.gateway,
       fleetDevice:fleet.find(f=>f.device.id===item.gateway.id),
       children:[item],
     });
   }

   return Array.from(map.values());
 },[fleet,managed]);

 return <section className="panel relative overflow-hidden">
   <img src={bg} className="pointer-events-none absolute inset-0 size-full object-cover opacity-45"/>
   <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background/70 via-background/40 to-background/85"/>

   <div className="relative p-5">
     <div className="flex flex-wrap items-center justify-between gap-3">
       <div className="flex items-center gap-3">
         <span className="label-caps">Fleet topology</span>
         <select className="rounded-lg border border-border/70 bg-surface-2/80 px-3 py-1.5 text-sm">
           <option>Health view</option>
           <option>Power view</option>
           <option>Protocol view</option>
         </select>
       </div>

       <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${online===fleet.length?'border-online/40 bg-online/10':'border-degraded/40 bg-degraded/10'}`}>
         <CheckCircle2 size={18} className={online===fleet.length?'text-online':'text-degraded'}/>
         <div>
           <p className="text-sm leading-none font-semibold">{fleet.length} Devices</p>
           <p className="text-xs text-muted-foreground">
             {online===fleet.length?'All systems nominal':`${online} online · attention required`}
           </p>
         </div>
       </div>
     </div>

     <div className="relative mt-4 min-h-[420px]">
       <div className="absolute top-2 left-0 space-y-2 rounded-xl border border-border/70 bg-surface-1/80 px-4 py-3 backdrop-blur">
         {(['ONLINE','DEGRADED','OFFLINE','UNKNOWN'] as ConnectivityState[]).map(state=>
           <div key={state} className="flex items-center gap-2 text-xs text-muted-foreground">
             <Dot state={state}/>
             {stateName[state]}
           </div>
         )}
       </div>

       <div className="absolute top-2 right-0 flex flex-col gap-2">
         {[Crosshair,Layers,Maximize2].map((Icon,i)=>
           <button key={i} className="grid size-10 place-items-center rounded-xl border border-border/70 bg-surface-1/80 text-muted-foreground backdrop-blur">
             <Icon size={17}/>
           </button>
         )}
       </div>

       <div className="flex flex-col items-center px-28 py-7">
         <div className="text-center">
           <p className="text-lg font-semibold tracking-[.12em] text-primary uppercase">PSOP Observability</p>
           <p className="text-xs text-muted-foreground">Secure &amp; Encrypted</p>
         </div>

         {site&&<>
           <div className="mt-5 glow-ring flex items-center gap-3 rounded-xl border border-border/70 bg-surface-1/80 px-5 py-3 backdrop-blur">
             <Building2 size={20} className="text-primary"/>
             <div>
               <p className="label-caps">Site</p>
               <p className="text-base font-semibold">{site.siteName}</p>
               <p className="text-xs text-muted-foreground">{site.siteCode}</p>
             </div>
           </div>
           <span className="h-7 w-px bg-gradient-to-b from-primary/70 to-primary/20"/>
         </>}

         <div className={`grid w-full gap-5 ${groups.length>1?'xl:grid-cols-2':'grid-cols-1'}`}>
           {groups.map(group=>{
             const gatewayState=group.gateway.connectivity.state;
             const gatewayFleet=group.fleetDevice;

             return <div key={group.gateway.id} className="flex min-w-0 flex-col items-center">
               <button
                 type="button"
                 onClick={()=>onSelect(group.gateway.id)}
                 className="glow-ring flex min-h-[86px] w-full max-w-[330px] items-center gap-4 rounded-xl border border-primary/40 bg-surface-1/85 px-5 py-3 text-left backdrop-blur transition-colors hover:border-primary/70"
               >
                 <img src={nvrImg} className="h-14 w-24 shrink-0 object-contain"/>
                 <div className="min-w-0">
                   <p className="truncate text-base font-semibold">{group.gateway.name}</p>
                   <p className={`flex items-center gap-2 text-sm ${tone[gatewayState]}`}>
                     <Dot state={gatewayState} pulse={gatewayState==='ONLINE'}/>
                     {stateName[gatewayState]}
                   </p>
                   <p className="mt-1 truncate text-xs text-muted-foreground">
                     {gatewayFleet ? (facts(gatewayFleet.telemetry)||group.gateway.externalId) : group.gateway.externalId}
                   </p>
                 </div>
               </button>

               <span className="h-5 w-px bg-gradient-to-b from-primary/60 to-primary/20"/>

               <div className={`grid w-full gap-3 ${
                 group.children.length === 1
                   ? 'mx-auto max-w-[240px] grid-cols-1'
                   : 'sm:grid-cols-2'
               }`}>
                 {group.children.map(child=>{
                   const childState=child.connectivity?.state??child.gateway.connectivity.state;

                   return <button
                     key={child.device.id}
                     type="button"
                     onClick={()=>onSelect(child.device.id)}
                     className={`flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-surface-1/80 px-4 py-3 text-left backdrop-blur transition-colors hover:border-primary/50 ${
                       group.children.length === 3 && group.children.indexOf(child) === 2
                         ? 'sm:col-span-2 sm:mx-auto sm:w-[calc(50%-0.375rem)]'
                         : ''
                     }`}
                   >
                     <img src={cameraImg} className="size-12 shrink-0 object-contain"/>
                     <div className="min-w-0">
                       <p className="truncate text-sm font-semibold">{child.device.name}</p>
                       <p className={`flex items-center gap-2 text-xs ${tone[childState]}`}>
                         <Dot state={childState} pulse={childState==='ONLINE'}/>
                         {stateName[childState]}
                       </p>
                       <p className="mt-1 truncate text-xs text-muted-foreground">
                         {facts(child.telemetry)||child.device.externalId}
                       </p>
                     </div>
                   </button>
                 })}
               </div>
             </div>
           })}
         </div>
       </div>
     </div>
   </div>
 </section>
}
export function Fleet({items,total,managed,search,site,state,sort,sites,hasFilters,onSearch,onSite,onState,onSort,onClear,onSelect}:{items:FleetDevice[];total:number;managed:GatewayManagedDevice[];search:string;site:string;state:FleetStateFilter;sort:FleetSort;sites:Array<[string,string]>;hasFilters:boolean;onSearch:(v:string)=>void;onSite:(v:string)=>void;onState:(v:FleetStateFilter)=>void;onSort:(v:FleetSort)=>void;onClear:()=>void;onSelect:(id:string)=>void}){return <section className="panel overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5"><span className="label-caps">Fleet workspace</span><p className="text-xs text-muted-foreground">{items.length} of {total}</p></div><div className="flex flex-wrap items-center gap-3 px-5 py-4"><div className="relative min-w-[220px] flex-1"><Search size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"/><input value={search} onChange={e=>onSearch(e.target.value)} placeholder="Search device, ID or site" className="h-10 w-full rounded-lg border border-border/70 bg-surface-1/70 pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/50"/></div><label className="flex h-10 items-center gap-2 rounded-lg border border-border/70 bg-surface-1/70 px-3 text-sm"><SlidersHorizontal size={15} className="text-muted-foreground"/><select value={site} onChange={e=>onSite(e.target.value)} className="bg-transparent outline-none"><option value="ALL">All sites</option>{sites.map(([id,l])=><option key={id} value={id}>{l}</option>)}</select></label><label className="flex h-10 items-center gap-2 rounded-lg border border-border/70 bg-surface-1/70 px-3 text-sm"><ArrowUpDown size={15} className="text-muted-foreground"/><select value={state} onChange={e=>onState(e.target.value as FleetStateFilter)} className="bg-transparent outline-none"><option value="ALL">All states</option><option value="ONLINE">Online</option><option value="DEGRADED">Degraded</option><option value="OFFLINE">Offline</option><option value="UNKNOWN">Unknown</option><option value="NEVER_SEEN">Never seen</option></select></label>{hasFilters&&<button onClick={onClear} className="h-10 rounded-lg border border-border/70 px-3 text-xs text-primary">Clear</button>}</div><div className="overflow-x-auto"><table className="w-full min-w-[1180px] border-collapse text-sm"><thead><tr className="border-y border-border/70 bg-surface-1/60">{['Device','State','Last heartbeat','Site','Verification','Model','Channel / PoE','Protocol','Firmware',''].map(c=><th key={c} className="label-caps px-4 py-2.5 text-left whitespace-nowrap">{c}</th>)}</tr></thead><tbody>{items.map(d=><tr key={d.device.id} onClick={()=>onSelect(d.device.id)} className="cursor-pointer border-b border-border/50 transition-colors hover:bg-primary/6"><td className="px-4 py-3"><div className="flex items-center gap-3"><span className="grid size-8 place-items-center rounded-lg bg-primary/12 text-primary"><DeviceIcon type={d.device.deviceType}/></span><div><p className="font-semibold">{d.device.name}</p><p className="text-xs tracking-wider text-muted-foreground">{d.device.externalId}</p></div></div></td><td className="px-4 py-3"><Pill state={d.connectivity.state}/></td><td className="px-4 py-3"><p className="font-semibold">{age(d.connectivity.ageSeconds)}</p><p className="text-xs text-muted-foreground">{fmt(d.connectivity.lastHeartbeatAt)}</p></td><td className="px-4 py-3"><p>{d.device.siteName}</p><p className="text-xs text-muted-foreground">{d.device.siteCode}</p></td><td className="px-4 py-3"><p>{d.monitoring.individualVerification==='RECORDER_VERIFIED'?'Recorder verified':d.monitoring.individualVerification==='DIRECT'?'Direct':'Not verified'}</p><p className="text-xs text-muted-foreground">{d.monitoring.source.replaceAll('_',' ')}</p></td><td className="px-4 py-3 whitespace-nowrap">{d.telemetry?.model||'—'}</td><td className="px-4 py-3 whitespace-nowrap">{facts(d.telemetry)||'—'}</td><td className="px-4 py-3">{d.telemetry?.protocol||'—'}</td><td className="max-w-[180px] truncate px-4 py-3 text-muted-foreground">{d.telemetry?.firmware||'—'}</td><td className="px-2"><MoreVertical size={16} className="text-muted-foreground"/></td></tr>)}</tbody></table></div>{managed.length>0&&<div className="border-t border-border/70 p-5"><div className="flex items-center justify-between"><span className="label-caps">Managed equipment</span><span className="text-xs text-muted-foreground">{managed.length} total</span></div><div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{managed.map(m=><button key={m.device.id} onClick={()=>onSelect(m.device.id)} className="flex items-center gap-3 rounded-xl border border-border/70 bg-surface-1/60 p-3 text-left"><span className="grid size-9 place-items-center rounded-lg bg-primary/12 text-primary"><DeviceIcon type={m.device.deviceType}/></span><span className="min-w-0 flex-1"><strong className="block truncate text-sm">{m.device.name}</strong><small className="block truncate text-xs text-muted-foreground">{m.monitoring.individualVerification==='RECORDER_VERIFIED'?`Verified by ${m.gateway.name}`:`Derived from ${m.gateway.name}`}</small></span><Dot state={m.connectivity?.state??m.gateway.connectivity.state}/></button>)}</div></div>}</section>}

export function Rail({alerts,events,onOpenAlerts}:{alerts:ActiveAlert[];events:ConnectivityEvent[];onOpenAlerts:()=>void}){return <aside className="panel overflow-hidden"><div className="flex items-center justify-between border-b border-border/70 px-5 py-4"><div><span className="label-caps">Incident rail</span><h2 className="mt-1 text-lg font-semibold">Active alerts</h2></div><button onClick={onOpenAlerts} className="rounded-full bg-critical/20 px-2.5 py-1 text-xs font-bold text-critical">{alerts.length}</button></div><div className="space-y-3 p-4">{alerts.length===0?<div className="rounded-xl border border-online/20 bg-online/5 p-4 text-center"><CheckCircle2 className="mx-auto text-online"/><p className="mt-2 text-sm font-semibold">No active alerts</p></div>:alerts.map(a=><article key={a.id} className="rounded-xl border border-border/70 bg-surface-1/60 p-3"><div className="flex gap-3"><ShieldAlert size={17} className={a.severity==='CRITICAL'?'text-critical':'text-degraded'}/><div className="min-w-0"><p className="text-sm font-semibold">{a.title}</p><p className="mt-1 text-xs text-muted-foreground">{a.deviceName} · {a.siteName}</p><p className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground"><Clock3 size={11}/>{fmt(a.openedAt)}</p></div></div></article>)}</div><button onClick={onOpenAlerts} className="mx-4 mb-4 flex w-[calc(100%-2rem)] items-center justify-center gap-2 rounded-lg border border-border/70 bg-surface-2/60 py-2 text-xs">View all alerts <ChevronRight size={14}/></button><div className="border-t border-border/70 p-5"><div className="flex items-center justify-between"><div><span className="label-caps">Activity stream</span><h3 className="mt-1 text-base font-semibold">Recent changes</h3></div><Activity size={17} className="text-primary"/></div><div className="mt-4 space-y-4">{events.slice(0,6).map(e=><div key={`${e.camera_id}-${e.timestamp}`} className="flex gap-3"><Dot state={e.current_state}/><div><p className="text-xs font-semibold">{e.device_name}</p><p className="text-[11px] text-muted-foreground">{e.previous_state?`${e.previous_state} → `:''}{e.current_state}</p><p className="text-[10px] text-muted-foreground">{fmt(e.detected_at)}</p></div></div>)}</div></div></aside>}

export function Incidents({items,onOpen}:{items:OperationalIncident[];onOpen:()=>void}){if(!items.length)return null;return <section className="panel overflow-hidden"><div className="flex items-center justify-between px-5 py-4"><div><span className="label-caps">Incident workspace</span><h2 className="mt-1 text-lg font-semibold">Recent incidents</h2></div><button onClick={onOpen} className="rounded-lg border border-border/70 px-3 py-2 text-xs text-primary">View history</button></div><div className="grid gap-3 border-t border-border/70 p-4 md:grid-cols-2">{items.slice(0,4).map(i=><button key={i.id} onClick={onOpen} className="rounded-xl border border-border/70 bg-surface-1/60 p-4 text-left"><div className="flex justify-between gap-3"><strong className="text-sm">{i.title}</strong><span className={i.severity==='CRITICAL'?'text-critical':'text-degraded'}>{i.severity}</span></div><p className="mt-2 text-xs text-muted-foreground">{i.deviceName} · {i.siteName}</p></button>)}</div></section>}
