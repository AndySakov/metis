# RDMA tech in Mac Studio
_date: 2025-12-20 · id: 6946e295-8c44-832c-b14e-7d95cd2c9cc9_

## USER

with the new rdma tech available on mac studios, tell me what are the outrageous tech capabilities i can use

## ASSISTANT

RDMA-over-Thunderbolt on **Mac Studio (Thunderbolt 5)** is basically Apple sneaking a *supercomputer-y* interconnect into a normal desktop: **macOS Tahoe 26.2 adds “RDMA over Thunderbolt,” enabling low-latency communication between Thunderbolt 5 hosts (explicitly called out for distributed AI inference with MLX).** citeturn3search4

That only becomes “outrageous” when you have **2+ Thunderbolt 5 Macs** (Mac Studio + another Studio / mini / MBP) and software that actually uses it.

## Outrageous things you can do

### 1) Build a “one giant VRAM box” out of multiple Mac Studios (local LLMs that don’t fit on one machine)
People are already doing **4× Mac Studio clusters** and effectively pooling *huge* unified-memory capacity for giant models (think “this would normally force me into a GPU server or the cloud”). citeturn7search1turn5search13  
If you want the easiest on-ramp, **Exo** is explicitly built for this and ships “day-0 support” for RDMA over TB5. citeturn5search13turn7search1

### 2) Real tensor-parallel inference that scales *better* than “Ethernet + hope”
Apple’s MLX ecosystem has already wired in an RDMA-backed distributed comms backend: MLX’s distributed docs mention **RDMA over Thunderbolt (macOS 26.2+)** and a backend (JACCL) that targets much lower latency than older approaches. citeturn3search2  
Translation: multi-machine inference becomes *way* less “waiting on the network every layer.”

### 3) DIY HPC / MPI-style workloads over “InfiniBand-like” APIs… using Thunderbolt cables
The RDMA stack is exposed in a way HPC folks recognize (ibverbs-style ecosystems get discussed heavily), which means a bunch of classic cluster patterns become realistic on a desk: distributed simulation, numerical work, parallel data processing, etc. citeturn1search5turn5search14  
(It’s not that every app magically gets faster—it’s that you can now write/port apps that assume fast RDMA links.)

### 4) A real-time multi-node “pipeline machine” for media + AI
Because Thunderbolt 5 on Mac Studio is *very* high bandwidth (up to **120 Gb/s** on supported ports), you can do silly-fast node pipelines where each Mac specializes:
- Node A: ingest/capture/transcode
- Node B: embeddings / RAG / retrieval
- Node C: LLM reasoning + tool-calling
- Node D: diffusion/video model or post-processing  
TB5 capability is there on Mac Studio hardware. citeturn4search0turn4search2  
RDMA is what makes the “handoffs” between nodes feel less like a normal network hop.

### 5) “Private cloud” vibes: keep big-model capability fully on-prem
The practical superpower: **run huge models locally** (privacy, cost control, offline) without immediately jumping to rented GPUs—especially for workloads where you care about *memory capacity* as much as raw flops. This is exactly the direction Apple/MLX + the community demos are pushing. citeturn5search3turn3search2turn7search1

## What you need (reality check)
- **macOS Tahoe 26.2+** (that’s where RDMA-over-Thunderbolt shows up). citeturn3search4  
- **Thunderbolt 5 hosts** (Mac Studio has TB5; some configs have more TB5 ports than others). citeturn4search0turn4search1  
- A stack that uses it: **MLX distributed** or **Exo** are the clearest “today” paths. citeturn3search2turn5search13

If you tell me how many Macs you can physically cable together (2? 3? 4?) and what you want to do (LLMs, video, compute), I’ll suggest the most “ridiculous but actually useful” setup.

navlistMore context on the Mac Studio generation that made this possibleturn4news24

## USER

what's the biggest setup i can achieve, assuming mac studios as the primary work horses and a top line mbp as the root node

## ASSISTANT

If you’re optimizing for **“biggest possible” RDMA/TB5 cluster**, the limiting factor isn’t compute—it’s **interconnect topology**.

### Hard constraints (what your ports allow)
- **Top-line MBP (M4 Pro/Max models)**: **3× Thunderbolt 5 ports**. citeturn0search3  
- **Mac Studio (2025)**
  - **M4 Max**: **4× TB5** (rear) + **2× USB-C 10Gb/s** (front). citeturn4view0  
  - **M3 Ultra**: **6× TB5 total** (4 rear + 2 front), and can be configured up to **512GB unified memory** per node. citeturn4view0
- **No Thunderbolt 5 switches** in practice right now, so you can’t “Ethernet-switch” a bunch of Macs together over TB5; you end up directly wiring machines together. citeturn2view0

---

## Biggest setup that’s actually been demonstrated (today)
### **4× Mac Studio (M3 Ultra) RDMA cluster**, with your MBP as the controller
This is the “current reality” ceiling people are showing with RDMA-over-TB5: **four Macs cross-connected** for RDMA. citeturn2view0turn2view0

**What that buys you**
- If you spec each Studio to **512GB**, that’s **2TB unified memory** across the cluster (4 × 512GB). citeturn4view0  
- This is exactly the kind of setup being used to run absurdly large local models (e.g., “hundreds of GB” class). citeturn2view0turn2view0

**How to wire it (the “full mesh” way)**
- 4 machines = **6 Thunderbolt cables** (each pair connected).  
- Each Studio consumes **3 TB5 ports** for the mesh, leaving **3 TB5 ports free** (for storage, displays, etc.). citeturn4view0turn2view0  
- Your **MBP should *not* be in the RDMA fabric**—use it as the “root node” for orchestration/SSH/monitoring over normal networking, and let the Studios do the RDMA heavy lifting. (This avoids turning your laptop into the bottleneck.)

---

## Biggest setup if you *insist* the MBP is inside the RDMA fabric
If the RDMA topology requires “everyone connected to everyone” (the common assumption right now), then your MBP’s **3 TB5 ports** cap you at:

### **MBP + 3 Mac Studios** (4 total machines)
Because in an all-to-all mesh of 4 machines, each node needs **3 links**—and your MBP has exactly **3 TB5 ports**. citeturn0search3

This is “maximal” *for the laptop-as-a-participant* case, but it’s usually the **wrong** way to build the cluster.

---

## Theoretical “absolute max” if scaling beyond 4 becomes supported
If RDMA-over-TB5 ends up working cleanly with >4 Macs, then with **M3 Ultra Mac Studios (6× TB5 ports each)**, the theoretical full-mesh maximum is:

### **7 Mac Studios** (because each needs 6 ports to talk to the other 6)
…but it’s wildly cable-heavy:
- 7 nodes → **21 Thunderbolt cables**  
- And you’re basically out of TB5 ports for anything else. citeturn4view0turn2view0

Also: one well-known tester explicitly says **“right now” you can only cross-connect up to four Macs**, while hinting it may not be a hard limit forever. citeturn2view0

---

## What I’d call the “max sane” build (if you want something outrageous but usable)
**Root / control plane**
- 1× top-line MBP (your “root node”)

**RDMA compute plane**
- **4× Mac Studio (M3 Ultra), each with 512GB** (if you’re truly going for broke) citeturn4view0turn2view0

**Cabling**
- Full-mesh TB5 between the Studios (6 cables)

If you tell me your target workload (LLMs only vs. LLM + video + storage), I’ll suggest a concrete port map (which ports go to mesh vs. storage vs. displays) so you don’t accidentally build a cable hydra that’s impossible to maintain.

navlistRecent context on Mac Studio + Thunderbolt 5 ecosystemturn0news34,turn0news36,turn0news38,turn0news35

## USER

lets head into the hypothetical with the 7 mac studios, tell me the full compute in hard units and then flops

## ASSISTANT

Alright — **hypothetical “7× Mac Studio (M3 Ultra, maxed)” compute plane**, with your MBP just orchestrating.

I’m assuming each Studio is configured as: **M3 Ultra (32-core CPU, 80-core GPU, 32-core Neural Engine), 512GB unified memory, 819 GB/s unified memory bandwidth**. citeturn2search8turn2search2turn1search6

## 7-node cluster compute in hard units

### CPU
- **32 CPU cores per node** × 7 = **224 CPU cores total** citeturn2search8

### GPU
- **80 GPU cores per node** × 7 = **560 GPU cores total** citeturn2search8

### Neural Engine
- **32 Neural Engine cores per node** × 7 = **224 Neural Engine cores total** citeturn2search8

### Unified memory (capacity)
- **512GB per node** × 7 = **3584GB unified memory total** (= **3.584 TB**, decimal) citeturn2search2turn2search8

### Unified memory bandwidth (local, per-node)
- **819 GB/s per node** × 7 = **5733 GB/s aggregate local bandwidth** (= **5.733 TB/s**) citeturn2search8turn1search6  
*(Important: this is “sum of each node’s local bandwidth,” not a single shared bus.)*

### Media engines (because it’s honestly part of the “outrageous” story)
Per Studio (M3 Ultra): **2 video decode**, **4 video encode**, **4 ProRes encode/decode**. citeturn2search8  
Cluster total:
- **14 decode engines**
- **28 encode engines**
- **28 ProRes engines** citeturn2search8

---

## Now the FLOPS

### GPU FP32 (single-precision) peak estimate
A commonly cited *theoretical* FP32 figure for the **80-core M3 Ultra GPU** is **~28.2 TFLOPS FP32**. citeturn1search0

So for **7 nodes**:
- **28.2 TFLOPS × 7 = 197.4 TFLOPS FP32** (≈ **0.197 PFLOPS**) citeturn1search0

### Neural Engine TOPS (inferred)
Apple states M3-generation Neural Engine is **18 TOPS for 16 cores** (for M3). citeturn2search11turn2search0  
M3 Ultra has **32 Neural Engine cores**. citeturn2search8turn2search5  
If you assume linear scaling with core count (reasonable, but Apple doesn’t publish an official TOPS number for M3 Ultra in the Mac Studio spec pages):
- **~36 TOPS per node**, and
- **~252 TOPS across 7 nodes** citeturn2search11turn2search8

If you want, I can also translate the above into “LLM practical units” (max in-memory model sizes at 4-bit/8-bit, expected tokens/sec ranges, and what scales vs what hits interconnect limits).

## USER

do it, and tell me what other scifi shit i can do besides ai

## ASSISTANT

Cool — let’s translate your **hypothetical 7× Mac Studio (M3 Ultra, 512GB)** “desk cluster” into **LLM-practical units**, then jump into **non-AI sci-fi**.

## 1) Practical “how big a model can I hold?”
Assuming each Studio is the max config: **512GB unified memory**, and you can shard model weights across the 7 nodes. citeturn4search3turn3view0

### Weight-only upper bounds (ignoring runtime overhead + KV cache)
Rule of thumb:
- **4-bit weights** ≈ **0.5 bytes/parameter** → **~2B params per 1GB**
- **8-bit weights** ≈ **1.0 byte/parameter** → **~1B params per 1GB**

So:
- **Per node (512GB)**  
  - **4-bit:** ~**1.0T params**  
  - **8-bit:** ~**512B params**
- **Across 7 nodes (3584GB total)**  
  - **4-bit:** ~**7.2T params**  
  - **8-bit:** ~**3.6T params**

Reality check: you never get to spend 100% of memory on weights (runtime buffers, paging, app overhead, plus KV cache), but it shows the *ceiling* is stupid-high.

### Concrete examples (weights only)
- **70B @ 4-bit:** ~35GB weights (easy on one node)  
- **235B @ 4-bit:** ~118GB weights (fits on one node; shown “squeezed into ~88GB” in practice with certain quants/settings) citeturn3view2turn3view1  
- **671B @ 4-bit:** ~336GB weights → this is why the **512GB M3 Ultra** can run monsters like **DeepSeek R1 671B** in-memory (people have demonstrated it, with macOS VRAM tuning). citeturn1view3turn4search3  

### KV cache (the thing that bites you)
Even if weights fit, **long context lengths** can eat tens to hundreds of GB depending on:
- context length (8k vs 128k)
- batch size / concurrency
- KV precision (FP16 vs FP8 vs quantized KV)
So “max model size” and “usable model size at 32k/128k context” are very different beasts.

## 2) Tokens/sec: what to expect
Two ways to use 7 nodes:

### A) The scaling that’s basically linear: **many users / many requests**
Run **one full model replica per Studio** (or a few replicas per Studio if the model is small) and load-balance requests.

Example baseline *per node* on **M3 Ultra** (user benchmark, MLX Q4, simple prompt):
- **70B @ Q4:** **~16.45 tok/s** citeturn3view1  
- **32B @ Q4:** **~33.25 tok/s** citeturn3view1  
- **7B @ Q4:** **~128.58 tok/s** citeturn3view1  

So, **cluster aggregate throughput** (7 nodes) looks like:
- 70B Q4: **~115.15 tok/s total** (7 × 16.45) citeturn3view1  
- 32B Q4: **~232.75 tok/s total** citeturn3view1  
- 7B Q4: **~900.06 tok/s total** citeturn3view1  

That’s the “private AI datacenter” vibe: not one stream going Mach 10, but **lots of simultaneous streams**.

### B) The scaling that’s *hard*: **one single stream gets faster**
This requires **model parallelism** (tensor/pipeline sharding) → nodes must exchange activations constantly, so interconnect latency matters.

This is exactly why **RDMA over Thunderbolt 5** exists in macOS 26.2: Apple explicitly calls it out for **distributed AI inference using MLX**. citeturn0search7turn4search4  
And MLX’s distributed docs say the **JACCL backend** using RDMA/TB can hit **~an order of magnitude lower comms latency** than the older ring approach. citeturn4search4turn4search7  

Still: don’t expect perfect linear scaling for “one chat session.” Expect “sometimes faster, sometimes worse” depending on the sharding strategy and model.

## 3) What actually hits the interconnect wall?
A quick feel for what scales well vs poorly:

Scales great:
- **Many independent inference jobs** (multi-user coding assistant, batch summarization, embeddings, RAG indexing)
- **Parameter sweeps / Monte Carlo sims**
- **Distributed builds / CI workloads**

Hits the wall:
- **Single-stream tensor-parallel inference** (all-reduce heavy)
- **Anything doing tight synchronous steps across nodes** at high frequency

## 4) Other sci-fi shit you can do besides AI
Here are the genuinely fun, “why is this on my desk” setups:

### A) A ProRes / H.264 / HEVC **transcode megafarm**
Each M3 Ultra node has a pile of dedicated media engines; across 7 nodes you can turn a mountain of footage into deliverables *fast* (and quietly), especially if you pipeline ingest → transcode → QC → packaging.

### B) A “mini render studio” for 3D / VFX pipelines
Not just rendering: full **USD scene processing**, simulation caching, texture baking, and nightly renders — split per shot/sequence per node. (This is the same “embarrassingly parallel” scaling that makes render farms work.)

### C) A personal **HPC cluster** for real science
- fluid sims, FEM, agent-based sims
- large-scale backtesting
- genomics-style pipelines
RDMA-over-TB5 is basically you cosplaying as an InfiniBand person, but with Mac Studios. citeturn0search7turn4search1

### D) A ridiculous **build farm**
If you do heavy native builds (Rust/Scala/C++/mobile), 7 nodes running distributed compilation + shared caching can make “clean build” feel illegal.

### E) A “live production brain”
One node does capture/ingest, one does real-time effects, one does encode/stream, one does recording + backups — all on your LAN, no cloud dependency.

And yeah: Thunderbolt 5 links are *fast* (Intel calls out **80 Gbps bidirectional** and up to **120 Gbps with Bandwidth Boost**, and Apple lists TB5 “up to 120Gb/s” on Macs that support it). citeturn4search1turn4search2  

If you tell me which “non-AI” lane you like most (media / rendering / HPC / build farm / live production), I’ll sketch a **7-node role layout** (what each Studio is “for”), plus the cabling/topology that won’t turn into a maintenance nightmare.

navlistBackground reading on the M3 Ultra Mac Studio and extreme local workloadsturn0news50,turn0news49

## USER

recall metis

## ASSISTANT

METIS is the personal “AI brain / copilot ecosystem” you’ve been designing — **Modular Engine for Thought, Insight, and Synthesis**.

The core idea (as you’ve described it across convos):

- **A JARVIS-like system** made of **modules/agents** you can plug in/out over time (v1 builds v2, self-upgrading loop).
- A **memory fabric** at the center: long-term, queryable, versioned memory (with strong privacy boundaries).
- A **“truth engine”** layer: provenance, verification, contradiction handling, confidence scoring — so it doesn’t become a hallucination scrapbook.
- **Research crawlers** / web runners (you’ve mentioned Stagehand + Browserbase + Playwright style tooling) that can gather evidence, then store structured notes + citations back into memory.
- **Security + privacy-first** architecture: PII-safe flows, sandboxed modules (Docker-style), local-first where possible, and verification/attestation for any 3rd-party agents.
- A long-term vision of an **agent marketplace** (ENS-style naming vibes), with **zk-style attestations** and maybe on-chain fee rails — but still modular enough to run fully offline if you want.

If you want to tie this to the **7× Mac Studio sci-fi cluster**: that setup is basically the “METIS datacenter-in-a-backpack” where you can split METIS into planes:

- **Control plane (MBP):** UI, orchestration, secrets, policy engine
- **Compute plane (Studios):** inference, search/indexing, sims/batch jobs
- **Data plane:** vector store / graph / object store, plus replication + backups

If you tell me what you want METIS to do *first* (research copilot, personal finance brain, dev copilot, travel ops, etc.), I’ll map a concrete v1 architecture onto that cluster.

