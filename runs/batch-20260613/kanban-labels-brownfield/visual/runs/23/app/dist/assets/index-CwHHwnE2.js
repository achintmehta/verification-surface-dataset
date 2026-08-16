(function(){const a=document.createElement("link").relList;if(a&&a.supports&&a.supports("modulepreload"))return;for(const n of document.querySelectorAll('link[rel="modulepreload"]'))r(n);new MutationObserver(n=>{for(const d of n)if(d.type==="childList")for(const b of d.addedNodes)b.tagName==="LINK"&&b.rel==="modulepreload"&&r(b)}).observe(document,{childList:!0,subtree:!0});function l(n){const d={};return n.integrity&&(d.integrity=n.integrity),n.referrerPolicy&&(d.referrerPolicy=n.referrerPolicy),n.crossOrigin==="use-credentials"?d.credentials="include":n.crossOrigin==="anonymous"?d.credentials="omit":d.credentials="same-origin",d}function r(n){if(n.ep)return;n.ep=!0;const d=l(n);fetch(n.href,d)}})();const g="http://localhost:3001",A=document.querySelector("#app");let y={columns:[]},p=[],h=new Set,E=null,v=null,k=null,w=!1,S=null;function i(e){return String(e).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function q(e){for(const a of y.columns){const l=a.cards.findIndex(r=>r.id===e);if(l!==-1)return{column:a,index:l,card:a.cards[l]}}return null}function T(e){let a=null;for(const l of y.columns){const r=l.cards.findIndex(n=>n.id===e);if(r!==-1){const[n]=l.cards.splice(r,1);a=n}}return a}function I(e){const a=new Set;return{columns:[...e.columns||[]].map(r=>({...r,cards:[...r.cards||[]].filter(n=>a.has(n.id)?!1:(a.add(n.id),!0)).map(n=>({...n,labels:n.labels||[]})).sort(j)})).sort((r,n)=>Number(r.position)-Number(n.position)||r.id.localeCompare(n.id))}}function j(e,a){return Number(e.position)-Number(a.position)||String(e.created_at).localeCompare(String(a.created_at))||e.id.localeCompare(a.id)}function O(e){if(h.size===0)return!0;const a=(e.labels||[]).map(l=>l.id);for(const l of h)if(a.includes(l))return!0;return!1}function x(e){const a=e.replace("#",""),l=a.length===3?a.split("").map(t=>t+t).join(""):a,r=parseInt(l.substring(0,2),16),n=parseInt(l.substring(2,4),16),d=parseInt(l.substring(4,6),16);return(.299*r+.587*n+.114*d)/255>.5?"#000000":"#ffffff"}function u(){A.innerHTML=`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-right">
        <button id="manage-labels-btn" class="manage-labels-btn" title="Manage Labels">🏷️ Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${M()}
    ${w?B():""}
    <main class="board">
      ${y.columns.map(D).join("")}
    </main>
    ${S?P():""}
  `,H()}function M(){return p.length===0?"":`
    <div class="filter-bar">
      <span class="filter-label">Filter by label:</span>
      ${p.map(e=>{const a=h.has(e.id);return`<button class="filter-chip ${a?"active":""}"
                  data-label-id="${i(e.id)}"
                  style="background:${a?i(e.color):"#e2e8f0"};color:${a?x(e.color):"#334155"};border-color:${i(e.color)}"
                  title="${i(e.name)}">${i(e.name)}</button>`}).join("")}
      ${h.size>0?'<button class="filter-clear" id="clear-filters">Clear</button>':""}
    </div>
  `}function B(){return`
    <div class="label-manager-overlay" id="label-manager-overlay">
      <div class="label-manager">
        <div class="label-manager-header">
          <h3>Manage Labels</h3>
          <button class="label-manager-close" id="label-manager-close">✕</button>
        </div>
        <form class="label-create-form" id="label-create-form">
          <input name="name" type="text" placeholder="Label name…" autocomplete="off" required />
          <input name="color" type="color" value="#2563eb" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${p.map(e=>`
            <div class="label-item" data-label-id="${i(e.id)}">
              <span class="label-chip" style="background:${i(e.color)};color:${x(e.color)}">${i(e.name)}</span>
              <input type="text" class="label-edit-name" value="${i(e.name)}" data-label-id="${i(e.id)}" />
              <input type="color" class="label-edit-color" value="${i(e.color)}" data-label-id="${i(e.id)}" />
              <button class="label-save-btn" data-label-id="${i(e.id)}" title="Save">💾</button>
              <button class="label-delete-btn" data-label-id="${i(e.id)}" title="Delete">🗑️</button>
            </div>
          `).join("")}
          ${p.length===0?'<p class="label-empty">No labels yet.</p>':""}
        </div>
      </div>
    </div>
  `}function P(){const e=q(S);if(!e)return"";const a=e.card,l=(a.labels||[]).map(r=>r.id);return`
    <div class="card-label-overlay" id="card-label-overlay">
      <div class="card-label-menu">
        <div class="label-manager-header">
          <h3>Labels for card</h3>
          <button class="label-manager-close" id="card-label-close">✕</button>
        </div>
        <p class="card-label-text">${i(a.text)}</p>
        <div class="card-label-list">
          ${p.map(r=>`
              <label class="card-label-option">
                <input type="checkbox" ${l.includes(r.id)?"checked":""} data-card-id="${i(a.id)}" data-label-id="${i(r.id)}" class="card-label-checkbox" />
                <span class="label-chip" style="background:${i(r.color)};color:${x(r.color)}">${i(r.name)}</span>
              </label>
            `).join("")}
          ${p.length===0?'<p class="label-empty">Create labels first using the Labels button.</p>':""}
        </div>
      </div>
    </div>
  `}function D(e){return`
    <section class="column" data-column-id="${i(e.id)}">
      <h2>${i(e.title)}</h2>
      <form class="add-card" data-column-id="${i(e.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${i(e.id)}">
        ${e.cards.map(a=>F(a)).join("")}
      </div>
    </section>
  `}function F(e){const a=!O(e),l=(e.labels||[]).map(r=>`<span class="card-label-chip" style="background:${i(r.color)};color:${x(r.color)}">${i(r.name)}</span>`).join("");return`
    <article class="card ${a?"card-hidden":""}" draggable="true" data-card-id="${i(e.id)}" title="Drag to move">
      <div class="card-text">${i(e.text)}</div>
      ${l?`<div class="card-labels">${l}</div>`:""}
      <button class="card-label-btn" data-card-id="${i(e.id)}" title="Manage labels">🏷️</button>
    </article>
  `}function H(){var e,a,l,r,n,d,b;document.querySelectorAll(".add-card").forEach(t=>{t.addEventListener("submit",async o=>{o.preventDefault();const c=t.elements.text,s=c.value.trim();s&&(c.value="",await R(t.dataset.columnId,s))})}),document.querySelectorAll(".card").forEach(t=>{t.addEventListener("dragstart",o=>{E=t.dataset.cardId,t.classList.add("dragging"),o.dataTransfer.effectAllowed="move"}),t.addEventListener("dragend",()=>{E=null,t.classList.remove("dragging"),document.querySelectorAll(".drop-target").forEach(o=>o.classList.remove("drop-target"))})}),document.querySelectorAll(".cards").forEach(t=>{t.addEventListener("dragover",o=>{o.preventDefault(),o.dataTransfer.dropEffect="move",t.classList.add("drop-target");const c=document.querySelector(".card.dragging");if(!c)return;const s=J(t,o.clientY);s?t.insertBefore(c,s):t.appendChild(c)}),t.addEventListener("dragleave",o=>{t.contains(o.relatedTarget)||t.classList.remove("drop-target")}),t.addEventListener("drop",async o=>{if(o.preventDefault(),t.classList.remove("drop-target"),!E)return;const c=t.dataset.columnId,{afterId:s,beforeId:$}=_(t,E);z(E,c,$,s),u();try{const m=await fetch(`${g}/api/cards/${E}/move`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:c,beforeId:$,afterId:s})});if(!m.ok)throw new Error((await m.json()).error||"Move failed")}catch(m){f(`Move failed: ${m.message}`,!0),y=I(await(await fetch(`${g}/api/board`)).json()),u()}})}),(e=document.getElementById("manage-labels-btn"))==null||e.addEventListener("click",()=>{w=!w,u()}),(a=document.getElementById("label-manager-close"))==null||a.addEventListener("click",()=>{w=!1,u()}),(l=document.getElementById("label-manager-overlay"))==null||l.addEventListener("click",t=>{t.target.id==="label-manager-overlay"&&(w=!1,u())}),(r=document.getElementById("label-create-form"))==null||r.addEventListener("submit",async t=>{t.preventDefault();const o=t.target.elements.name,c=t.target.elements.color,s=o.value.trim(),$=c.value.trim();if(s)try{const m=await fetch(`${g}/api/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:s,color:$})});if(!m.ok){const L=await m.json();f(`Label error: ${L.error}`,!0);return}o.value="",await C(),u()}catch(m){f(`Label create failed: ${m.message}`,!0)}}),document.querySelectorAll(".label-save-btn").forEach(t=>{t.addEventListener("click",async()=>{const o=t.dataset.labelId,c=document.querySelector(`.label-edit-name[data-label-id="${o}"]`),s=document.querySelector(`.label-edit-color[data-label-id="${o}"]`),$=c==null?void 0:c.value.trim(),m=s==null?void 0:s.value.trim();if($)try{const L=await fetch(`${g}/api/labels/${o}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:$,color:m})});if(!L.ok){const N=await L.json();f(`Label error: ${N.error}`,!0);return}await C(),u()}catch(L){f(`Label update failed: ${L.message}`,!0)}})}),document.querySelectorAll(".label-delete-btn").forEach(t=>{t.addEventListener("click",async()=>{const o=t.dataset.labelId;try{const c=await fetch(`${g}/api/labels/${o}`,{method:"DELETE"});if(!c.ok){const s=await c.json();f(`Label error: ${s.error}`,!0);return}h.delete(o),await C(),u()}catch(c){f(`Label delete failed: ${c.message}`,!0)}})}),document.querySelectorAll(".filter-chip").forEach(t=>{t.addEventListener("click",()=>{const o=t.dataset.labelId;h.has(o)?h.delete(o):h.add(o),u()})}),(n=document.getElementById("clear-filters"))==null||n.addEventListener("click",()=>{h.clear(),u()}),document.querySelectorAll(".card-label-btn").forEach(t=>{t.addEventListener("click",o=>{o.stopPropagation(),S=t.dataset.cardId,u()})}),(d=document.getElementById("card-label-close"))==null||d.addEventListener("click",()=>{S=null,u()}),(b=document.getElementById("card-label-overlay"))==null||b.addEventListener("click",t=>{t.target.id==="card-label-overlay"&&(S=null,u())}),document.querySelectorAll(".card-label-checkbox").forEach(t=>{t.addEventListener("change",async()=>{const o=t.dataset.cardId,c=t.dataset.labelId;try{if(t.checked){const s=await fetch(`${g}/api/cards/${o}/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({labelId:c})});if(!s.ok)throw new Error((await s.json()).error)}else{const s=await fetch(`${g}/api/cards/${o}/labels/${c}`,{method:"DELETE"});if(!s.ok)throw new Error((await s.json()).error)}}catch(s){f(`Label assign error: ${s.message}`,!0)}})})}function J(e,a){const l=[...e.querySelectorAll(".card:not(.dragging)")];let r=null,n=Number.NEGATIVE_INFINITY;for(const d of l){const b=d.getBoundingClientRect(),t=a-b.top-b.height/2;t<0&&t>n&&(n=t,r=d)}return r}function _(e,a){const l=[...e.querySelectorAll(".card")].map(n=>n.dataset.cardId),r=l.indexOf(a);return{afterId:r>0?l[r-1]:null,beforeId:r>=0&&r<l.length-1?l[r+1]:null}}function z(e,a,l,r){const n=T(e);if(!n)return;const d=y.columns.find(c=>c.id===a);if(!d)return;const b=r?d.cards.findIndex(c=>c.id===r):-1,t=l?d.cards.findIndex(c=>c.id===l):-1;let o=d.cards.length;b!==-1?o=b+1:t!==-1&&(o=t),d.cards.splice(o,0,{...n,column_id:a,optimistic:!0})}async function R(e,a){try{const l=await fetch(`${g}/api/cards`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:e,text:a})});if(!l.ok)throw new Error((await l.json()).error||"Create failed")}catch(l){f(`Create failed: ${l.message}`,!0)}}function K(e){if(e.type==="label-created"){const r=e.label;p.find(n=>n.id===r.id)||(p.push(r),p.sort((n,d)=>n.name.localeCompare(d.name))),u(),f("Synced");return}if(e.type==="label-updated"){const r=e.label,n=p.findIndex(d=>d.id===r.id);n!==-1&&(p[n]=r,p.sort((d,b)=>d.name.localeCompare(b.name))),e.board&&(y=I(e.board)),u(),f("Synced");return}if(e.type==="label-deleted"){p=p.filter(r=>r.id!==e.labelId),h.delete(e.labelId),e.board&&(y=I(e.board)),u(),f("Synced");return}if(e.type==="label-assigned"||e.type==="label-unassigned"){e.board&&(y=I(e.board)),u(),f("Synced");return}if(e.board){y=I(e.board),u(),f("Synced");return}if(!e.card)return;const a=e.card;T(a.id);const l=y.columns.find(r=>r.id===a.column_id||r.id===e.columnId);l&&(l.cards.push(a),l.cards.sort(j),u(),f("Synced"))}async function C(){try{const e=await fetch(`${g}/api/labels`);e.ok&&(p=await e.json())}catch{}}async function U(){const e=await fetch(`${g}/api/board`);if(!e.ok)throw new Error("Could not load board");y=I(await e.json()),await C(),u()}function Y(){v==null||v.close(),v=new EventSource(`${g}/api/stream`),v.addEventListener("connected",()=>f("Live")),v.addEventListener("mutation",e=>{K(JSON.parse(e.data))}),v.onerror=()=>f("Reconnecting…",!0)}function f(e,a=!1){const l=document.querySelector("#status");l&&(l.textContent=e,l.classList.toggle("warn",a)),clearTimeout(k),a&&(k=setTimeout(()=>f((v==null?void 0:v.readyState)===EventSource.OPEN?"Live":"Reconnecting…"),4e3))}async function G(){A.innerHTML='<div class="loading">Loading board…</div>';try{await U(),Y()}catch(e){A.innerHTML=`<div class="loading error">${i(e.message)}</div>`}}G();
