const $ = id => document.getElementById(id);
let user = null, game = null, authMode = "login", busy = false;
const fmt = n => Number(n || 0).toLocaleString("en-GB");
async function api(url, options = {}) {
  const response = await fetch(url, {...options, headers: {"Content-Type":"application/json", ...(options.headers || {})}, body: options.body ? JSON.stringify(options.body) : undefined});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
function setBusy(value) { busy = value; document.querySelectorAll("button").forEach(b => { if (b.dataset.keepEnabled !== "true") b.disabled = value || b.dataset.originalDisabled === "true"; }); }
function showModal() { $("modal").classList.remove("hidden"); $("authError").textContent = ""; }
function hideModal() { $("modal").classList.add("hidden"); }
function setAuthMode(mode) {
  authMode = mode; $("loginTab").classList.toggle("active", mode === "login"); $("registerTab").classList.toggle("active", mode === "register");
  $("modalTitle").textContent = mode === "login" ? "Welcome back" : "Create your player";
  $("modalDescription").textContent = mode === "login" ? "Log in to save your scores and join the global leaderboard." : "Claim your username and start building your high score.";
  $("authSubmit").innerHTML = mode === "login" ? 'LOG IN <span>→</span>' : 'CREATE ACCOUNT <span>→</span>';
  $("password").autocomplete = mode === "login" ? "current-password" : "new-password"; $("authError").textContent = "";
}
function renderUser() {
  $("accountButton").innerHTML = user ? `${escapeHtml(user.username.toUpperCase())} <span>↗</span>` : 'LOG IN <span>↗</span>';
  $("profileEmpty").classList.toggle("hidden", !!user); $("profileData").classList.toggle("hidden", !user);
  if (!user) { $("level").textContent="1"; $("bestScore").textContent="0"; $("lifetimeScore").textContent="0"; $("gamesPlayed").textContent="0"; $("milestoneCurrent").textContent="0 / 100"; $("milestoneProgress").style.width="0%"; $("milestonePercent").textContent="0%"; return; }
  $("avatar").textContent=user.username[0].toUpperCase(); $("profileName").textContent=user.username; $("bioInput").value=user.bio||""; $("profileStats").textContent=`Level ${user.level} · ${fmt(user.xp)} XP`;
  $("level").textContent=user.level; $("bestScore").textContent=fmt(user.bestScore); $("lifetimeScore").textContent=fmt(user.lifetimeScore); $("gamesPlayed").textContent=fmt(user.gamesPlayed);
  const progress=Math.min(100,Math.round(user.bestScore)); $("milestoneCurrent").textContent=`${fmt(Math.min(user.bestScore,100))} / 100`; $("milestoneProgress").style.width=`${progress}%`; $("milestonePercent").textContent=`${progress}%`;
  if(user.bestScore>=100){$("milestoneTitle").textContent="Fortune found";$("milestoneSub").textContent="Next goal: beat your personal best";}
}
function renderGame() {
  const board=$("board"); board.innerHTML=""; const revealed=game?.revealed||[];
  const count=game?.tileCount||Number($("tileCount").value||9); board.style.gridTemplateColumns=`repeat(${count<=9?3:count<=16?4:6},minmax(0,1fr))`;
  for(let i=1;i<=count;i++){const tile=document.createElement("button");tile.className="tile";tile.type="button";const open=revealed.includes(i);const isBomb=(game?.mineTiles||[]).includes(i);tile.disabled=!user||!game||game.status!=="playing"||open||busy;tile.innerHTML=`<span>${String(i).padStart(2,"0")}</span><b>${isBomb?"✹":open?"◆":"?"}</b>`;if(open)tile.classList.add("gem");if(isBomb)tile.classList.add("bomb");tile.addEventListener("click",()=>pickTile(i));board.appendChild(tile);}
  $("runBank").textContent=fmt(game?.runBank||0);$("roundNumber").textContent=game?game.round:"—";$("gemsFound").innerHTML=`${game?.roundGems||0}<span class="muted"> / ${game?.safeTiles||count}</span>`; $("tileCount").value=String(game?.tileCount||$("tileCount").value||9); $("mineCount").value=String(game?.mineCount||$("mineCount").value||3); $("tileCount").disabled=!!game; $("mineCount").disabled=!!game; $("odds").textContent=game?`${(game.safeChance*100).toFixed(1)}% gem · ${(game.mineChance*100).toFixed(1)}% mine on next pick`:"At least one gem is guaranteed on every board.";$("atRisk").textContent=fmt(game?.points||0);$("streak").textContent=`STREAK ×${game?.streak||0}`;
  $("message").textContent=game?.message||(user?"Start a run and see how far your luck takes you.":"Log in to start your run. Find gems, build your streak, and bank before the bomb finds you.");
  $("bankButton").disabled=!user||!game||game.status!=="playing"||game.points<=0||busy;
  const main=$("mainButton");if(!user){main.innerHTML='LOG IN TO PLAY <span>→</span>';main.disabled=false;}else if(!game){main.innerHTML='START A RUN <span>→</span>';main.disabled=busy;}else if(game.status==="playing"){main.innerHTML='CASH OUT <span>↗</span>';main.disabled=busy;}else{main.innerHTML='NEXT ROUND <span>→</span>';main.disabled=busy;}
}
async function refreshLeaderboard(){try{const data=await api("/api/leaderboard");const body=$("leaderboard");if(!data.players.length){body.innerHTML='<tr><td colspan="4" class="table-loading">No scores yet. Be the first on the board.</td></tr>';return;}body.innerHTML=data.players.map(p=>`<tr><td class="${p.rank<=3?"rank-top":""}">#${p.rank}</td><td><button class="player-link" data-player="${escapeHtml(p.username)}">${escapeHtml(p.username)}</button></td><td>${fmt(p.bestScore)}</td><td>${fmt(p.lifetimeScore)}</td></tr>`).join(""); body.querySelectorAll("[data-player]").forEach(b=>b.addEventListener("click",()=>showPlayer(b.dataset.player)));}catch{$("leaderboard").innerHTML='<tr><td colspan="4" class="table-loading">Leaderboard unavailable.</td></tr>';}}
function escapeHtml(value){return String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
async function sync(){try{const data=await api("/api/me");user=data.user;game=data.game;renderUser();renderGame();$("connection").innerHTML='<i></i> ONLINE';}catch{$("connection").textContent="OFFLINE";}}
async function pickTile(tile){if(busy)return;setBusy(true);try{const data=await api("/api/game/pick",{method:"POST",body:{tile}});game=data.game;if(data.event==="bomb")game.message=`💥 BOOM! ${fmt(data.lost)} points lost. Your bank is safe.`;else if(data.event==="perfect")game.message=`✦ PERFECT ROUND! ${fmt(data.bonus)} bonus points. Round total safely banked!`;}catch(e){$("message").textContent=e.message;}finally{setBusy(false);renderGame();}}
async function startRun(){setBusy(true);try{const data=await api("/api/game/start",{method:"POST",body:{tileCount:Number($("tileCount").value),mineCount:Number($("mineCount").value)}});game=data.game;}catch(e){$("message").textContent=e.message;}finally{setBusy(false);renderGame();}}
async function continueRun(){setBusy(true);try{const data=await api("/api/game/continue",{method:"POST"});game=data.game;}catch(e){$("message").textContent=e.message;}finally{setBusy(false);renderGame();}}
async function cashOut(){if(!confirm("Cash out this run and save your score to the global leaderboard?"))return;setBusy(true);try{const data=await api("/api/game/cashout",{method:"POST"});user=data.user;game=null;renderUser();renderGame();await refreshLeaderboard();$("resultTitle").textContent="Cashed out!";$("resultText").textContent=`You earned ${fmt(data.xpEarned)} XP. Your run has been added to the leaderboard.`;$("resultScore").textContent=fmt(data.score);$("resultModal").classList.remove("hidden");}catch(e){$("message").textContent=e.message;}finally{setBusy(false);renderGame();}}
$("accountButton").addEventListener("click",()=>{if(user){if(confirm(`Log out of ${user.username}?`))api("/api/logout",{method:"POST"}).then(()=>{user=null;game=null;renderUser();renderGame();refreshLeaderboard();});}else showModal();});
$("closeModal").addEventListener("click",hideModal);$("modal").addEventListener("click",e=>{if(e.target.dataset.close)hideModal();});$("loginTab").addEventListener("click",()=>setAuthMode("login"));$("registerTab").addEventListener("click",()=>setAuthMode("register"));
$("username").addEventListener("input",e=>{const pos=e.target.selectionStart;e.target.value=e.target.value.toLowerCase().replace(/[^a-z0-9_]/g,"");e.target.setSelectionRange(pos,pos);});
$("authForm").addEventListener("submit",async e=>{e.preventDefault();if(busy)return;const username=$("username").value.trim().toLowerCase(),password=$("password").value;$("authError").textContent="";const submit=$("authSubmit");submit.disabled=true;submit.textContent=authMode==="login"?"LOGGING IN…":"CREATING ACCOUNT…";try{const data=await api(`/api/${authMode}`,{method:"POST",body:{username,password}});user=data.user;game=null;hideModal();renderUser();renderGame();await refreshLeaderboard();$("authForm").reset();}catch(err){$("authError").textContent=err.message;}finally{submit.disabled=false;submit.innerHTML=authMode==="login"?'LOG IN <span>→</span>':'CREATE ACCOUNT <span>→</span>';}});
$("bankButton").addEventListener("click",async()=>{setBusy(true);try{const data=await api("/api/game/bank",{method:"POST"});game=data.game;}catch(e){$("message").textContent=e.message;}finally{setBusy(false);renderGame();}});
$("mainButton").addEventListener("click",()=>{if(!user)showModal();else if(!game)startRun();else if(game.status==="playing")cashOut();else continueRun();});
$("resultClose").addEventListener("click",()=>$("resultModal").classList.add("hidden"));
async function showPlayer(name){try{const d=await api(`/api/profile/${encodeURIComponent(name)}`);const p=d.profile;$("publicName").textContent=p.username;$("publicBio").textContent=p.bio||"No bio yet.";$("publicStats").innerHTML=`<div><b>${fmt(p.level)}</b><span>LEVEL</span></div><div><b>${fmt(p.bestScore)}</b><span>BEST RUN</span></div><div><b>${fmt(p.totalGems)}</b><span>GEMS</span></div><div><b>${fmt(p.gamesPlayed)}</b><span>RUNS</span></div>`;$("profileModal").classList.remove("hidden");}catch(e){$("profileResult").textContent=e.message;}}
$("saveBio").addEventListener("click",async()=>{try{const d=await api("/api/profile",{method:"PATCH",body:{bio:$("bioInput").value}});user=d.user;$("profileResult").textContent="Bio saved.";}catch(e){$("profileResult").textContent=e.message;}});
$("viewProfile").addEventListener("click",()=>showPlayer($("profileSearch").value.trim().toLowerCase()));
$("closeProfile").addEventListener("click",()=>$("profileModal").classList.add("hidden"));$("profileCloseButton").addEventListener("click",()=>$("profileModal").classList.add("hidden"));$("profileModal").addEventListener("click",e=>{if(e.target.dataset.profileClose)$("profileModal").classList.add("hidden");});
$("tileCount").addEventListener("change",()=>{const n=Number($("tileCount").value);[...$("mineCount").options].forEach(o=>o.disabled=Number(o.value)>=n);if(Number($("mineCount").value)>=n)$("mineCount").value="1";});
(async function init(){await sync();await refreshLeaderboard();setInterval(refreshLeaderboard,30000);})();