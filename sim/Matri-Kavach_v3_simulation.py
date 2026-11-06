"""Synthetic district Monte Carlo: nearest-hospital referral vs Matri-Kavach (confirm-in-transit).
All data fake. Assumptions are listed in ASSUMPTIONS and printed with results."""
import random, math, statistics as st, json
H = [("CHC-1",15,15,0.45,False),("CHC-2",45,15,0.45,False),("CHC-3",15,45,0.40,False),
     ("District Hospital",35,35,0.75,False),("Medical College",55,50,0.97,True)]
ASSUMPTIONS=dict(district="60x60 km, 15 PHCs, 5 receiving hospitals", speed_kmph=30, road_detour=1.4,
  night_readiness="CHCs 40-45%, DH 75%, MC 97% (MC never refuses)", lost_at_unready_facility_min=60,
  reply_window_min=2, ivr_extra_min=3, reply_rate=0.85, status_accuracy=0.9, wrong_ready_confirmation=0.05)
SPEED=30/60; DET=1.4; TURN=60; CONFIRM=2; IVR=3; ACC=0.9; FALSE_OK=0.05
def tt(a,b): return math.dist(a,b)*DET/SPEED
def run(policy, n=20000, compliance=0.85, seed=1):
    rnd=random.Random(seed); PHC=[(rnd.uniform(0,60),rnd.uniform(0,60)) for _ in range(15)]
    T=[];V=[];R=[]
    for _ in range(n):
        p=rnd.choice(PHC); ready={h[0]:(rnd.random()<h[3]) for h in H}
        known={h[0]:((ready[h[0]] if rnd.random()<ACC else not ready[h[0]]) if rnd.random()<compliance else None) for h in H}
        t=0; pos=p; visits=0; rer=0
        if policy=="nearest":
            tried=set()
            while True:
                h=min([h for h in H if h[0] not in tried],key=lambda h:tt(pos,(h[1],h[2])))
                t+=tt(pos,(h[1],h[2])); pos=(h[1],h[2]); visits+=1; tried.add(h[0])
                if ready[h[0]] or h[4]: break
                t+=TURN
        else:
            def key(h,pos):
                k=known[h[0]]; pr=1.0 if h[4] else (0.9 if k is True else (h[3] if k is None else 0.1))
                return tt(pos,(h[1],h[2]))+(1-pr)*30
            left=list(H)
            while True:
                tgt=min(left,key=lambda h:key(h,pos)); left.remove(tgt)
                if ready[tgt[0]] or tgt[4]:
                    t+=tt(pos,(tgt[1],tgt[2])); visits+=1; break
                if rnd.random()<FALSE_OK:  # hospital wrongly says ready; found out on arrival
                    t+=tt(pos,(tgt[1],tgt[2])); pos=(tgt[1],tgt[2]); visits+=1; t+=TURN; continue
                d=CONFIRM if rnd.random()<0.85 else CONFIRM+IVR
                full=tt(pos,(tgt[1],tgt[2])); f=min(1,d/full)
                pos=(pos[0]+(tgt[1]-pos[0])*f,pos[1]+(tgt[2]-pos[1])*f); t+=min(d,full); rer+=1
        T.append(t);V.append(visits);R.append(rer)
    T2=sorted(T)
    return dict(median_min=round(st.median(T)),mean_min=round(st.mean(T)),p90_min=round(T2[int(.9*n)]),
      pct_first_facility_ready=round(100*sum(v==1 for v in V)/n,1),
      pct_2plus_facilities=round(100*sum(v>=2 for v in V)/n,1),
      pct_rerouted_in_transit=round(100*sum(r>0 for r in R)/n,1))
out={"assumptions":ASSUMPTIONS,"nearest_hospital":run("nearest"),
  "matri_kavach_85pct_checkins":run("mk",compliance=.85),
  "matri_kavach_60pct_checkins":run("mk",compliance=.60),
  "matri_kavach_no_checkins_confirm_only":run("mk",compliance=0)}
print(json.dumps(out,indent=1)); json.dump(out,open("sim.json","w"),indent=1)
