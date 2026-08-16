(function(){const a=document.createElement("link").relList;if(a&&a.supports&&a.supports("modulepreload"))return;for(const o of document.querySelectorAll('link[rel="modulepreload"]'))n(o);new MutationObserver(o=>{for(const i of o)if(i.type==="childList")for(const r of i.addedNodes)r.tagName==="LINK"&&r.rel==="modulepreload"&&n(r)}).observe(document,{childList:!0,subtree:!0});function t(o){const i={};return o.integrity&&(i.integrity=o.integrity),o.referrerPolicy&&(i.referrerPolicy=o.referrerPolicy),o.crossOrigin==="use-credentials"?i.credentials="include":o.crossOrigin==="anonymous"?i.credentials="omit":i.credentials="same-origin",i}function n(o){if(o.ep)return;o.ep=!0;const i=t(o);fetch(o.href,i)}})();const f="http://localhost:3001",L=document.querySelector("#app");let v={columns:[]},u=[],g=new Set,y=null,p=null,C=null;function c(e){return String(e).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function _(e){for(const a of v.columns){const t=a.cards.findIndex(n=>n.id===e);if(t!==-1)return{column:a,index:t,card:a.cards[t]}}return null}function I(e){let a=null;for(const t of v.columns){const n=t.cards.findIndex(o=>o.id===e);if(n!==-1){const[o]=t.cards.splice(n,1);a=o}}return a}function w(e){const a=new Set;return{columns:[...e.columns||[]].map(n=>({...n,cards:[...n.cards||[]].filter(o=>a.has(o.id)?!1:(a.add(o.id),!0)).map(o=>({...o,labels:o.labels||[]})).sort(k)})).sort((n,o)=>Number(n.position)-Number(o.position)||n.id.localeCompare(o.id))}}function k(e,a){return Number(e.position)-Number(a.position)||String(e.created_at).localeCompare(String(a.created_at))||e.id.localeCompare(a.id)}function j(e){if(g.size===0)return!0;const a=new Set((e.labels||[]).map(t=>t.id));for(const t of g)if(a.has(t))return!0;return!1}function h(){L.innerHTML=`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    ${q()}
    <main class="board">
      ${v.columns.map(N).join("")}
    </main>
    ${M()}
  `,D()}function q(){if(u.length===0)return`<div class="label-bar">
      <span class="label-bar__hint">No labels yet — create one below ↓</span>
      <button class="label-bar__manage-btn" id="toggle-label-manager">Manage Labels</button>
    </div>`;const e=u.map(t=>`<button
      class="label-chip label-chip--filter${g.has(t.id)?" label-chip--active":""}"
      data-label-id="${c(t.id)}"
      style="--chip-color:${c(t.color)}"
      title="Filter by ${c(t.name)}"
    >${c(t.name)}</button>`).join(""),a=g.size>0?'<button class="label-bar__clear" id="clear-filters">✕ Clear filter</button>':"";return`<div class="label-bar">
    <span class="label-bar__label">Filter:</span>
    <div class="label-bar__chips">${e}</div>
    ${a}
    <button class="label-bar__manage-btn" id="toggle-label-manager">Manage Labels</button>
  </div>`}function M(){return`
    <div class="lm-overlay" id="label-manager-overlay" hidden>
      <div class="lm-panel" role="dialog" aria-modal="true" aria-label="Label Manager">
        <div class="lm-header">
          <h2>Label Manager</h2>
          <button class="lm-close" id="close-label-manager" aria-label="Close">✕</button>
        </div>

        <form class="lm-create-form" id="create-label-form">
          <input
            class="lm-input"
            name="name"
            type="text"
            maxlength="60"
            placeholder="Label name…"
            autocomplete="off"
            required
          />
          <input
            class="lm-color"
            name="color"
            type="color"
            value="#6366f1"
            title="Pick a color"
          />
          <button class="lm-btn lm-btn--primary" type="submit">Add Label</button>
        </form>
        <p class="lm-error" id="create-label-error" hidden></p>

        <ul class="lm-list" id="label-list">
          ${u.map(x).join("")}
        </ul>
      </div>
    </div>
  `}function x(e){return`
    <li class="lm-row" data-label-id="${c(e.id)}">
      <span class="lm-swatch" style="background:${c(e.color)}"></span>
      <span class="lm-name" data-field="name">${c(e.name)}</span>
      <div class="lm-row-actions">
        <button class="lm-btn lm-btn--edit" data-action="edit-label" data-label-id="${c(e.id)}" title="Rename / recolor">Edit</button>
        <button class="lm-btn lm-btn--danger" data-action="delete-label" data-label-id="${c(e.id)}" title="Delete label">Delete</button>
      </div>
    </li>
  `}function N(e){const a=e.cards.filter(j),t=e.cards.length-a.length,n=t>0?`<p class="column-hidden-note">${t} card${t>1?"s":""} hidden by filter</p>`:"";return`
    <section class="column" data-column-id="${c(e.id)}">
      <h2>${c(e.title)}</h2>
      <form class="add-card" data-column-id="${c(e.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      ${n}
      <div class="cards" data-column-id="${c(e.id)}">
        ${a.map(O).join("")}
      </div>
    </section>
  `}function O(e){const t=`
    <div class="card-labels">
      ${(e.labels||[]).map(n=>`
    <span
      class="label-chip label-chip--card"
      style="--chip-color:${c(n.color)}"
      data-label-id="${c(n.id)}"
    >${c(n.name)}</span>
  `).join("")}
      <button class="card-label-btn" data-action="open-assign" data-card-id="${c(e.id)}" title="Assign labels">＋</button>
    </div>
  `;return`
    <article class="card" draggable="true" data-card-id="${c(e.id)}" title="Drag to move">
      <div class="card-text">${c(e.text)}</div>
      ${t}
    </article>
  `}function P(e,a){S();const t=_(e);if(!t)return;const n=t.card,o=new Set((n.labels||[]).map(l=>l.id)),i=document.createElement("div");if(i.className="assign-popover",i.dataset.popoverCardId=e,u.length===0)i.innerHTML='<p class="assign-popover__empty">No labels yet. Create one in <em>Manage Labels</em>.</p>';else{const l=u.map(s=>{const d=o.has(s.id);return`<label class="assign-popover__item">
        <input type="checkbox" data-label-id="${c(s.id)}" ${d?"checked":""} />
        <span class="assign-popover__swatch" style="background:${c(s.color)}"></span>
        <span>${c(s.name)}</span>
      </label>`}).join("");i.innerHTML=`<div class="assign-popover__list">${l}</div>`}document.body.appendChild(i);const r=a.getBoundingClientRect();i.style.top=`${r.bottom+window.scrollY+4}px`,i.style.left=`${r.left+window.scrollX}px`,i.addEventListener("change",async l=>{const s=l.target;if(s.type!=="checkbox")return;const d=s.dataset.labelId;s.checked?await F(e,d):await J(e,d)}),setTimeout(()=>{document.addEventListener("click",E,{capture:!0,once:!1})},0)}function E(e){const a=document.querySelector(".assign-popover");if(!a){document.removeEventListener("click",E,{capture:!0});return}!a.contains(e.target)&&!e.target.closest('[data-action="open-assign"]')&&(S(),document.removeEventListener("click",E,{capture:!0}))}function S(){var e;(e=document.querySelector(".assign-popover"))==null||e.remove()}function D(){var e,a,t,n,o,i;document.querySelectorAll(".add-card").forEach(r=>{r.addEventListener("submit",async l=>{l.preventDefault();const s=r.elements.text,d=s.value.trim();d&&(s.value="",await R(r.dataset.columnId,d))})}),document.querySelectorAll(".card").forEach(r=>{r.addEventListener("dragstart",l=>{y=r.dataset.cardId,r.classList.add("dragging"),l.dataTransfer.effectAllowed="move"}),r.addEventListener("dragend",()=>{r.classList.remove("dragging"),y=null})}),document.querySelectorAll(".cards").forEach(r=>{r.addEventListener("dragover",l=>{l.preventDefault(),l.dataTransfer.dropEffect="move",r.classList.add("drop-target")}),r.addEventListener("dragleave",l=>{r.contains(l.relatedTarget)||r.classList.remove("drop-target")}),r.addEventListener("drop",async l=>{if(l.preventDefault(),r.classList.remove("drop-target"),!y)return;const s=r.dataset.columnId,{afterId:d,beforeId:b}=z(r,y);K(y,s,b,d),h(),await U(y,s,b,d)})}),document.querySelectorAll(".label-chip--filter").forEach(r=>{r.addEventListener("click",()=>{const l=r.dataset.labelId;g.has(l)?g.delete(l):g.add(l),h()})}),(e=document.getElementById("clear-filters"))==null||e.addEventListener("click",()=>{g.clear(),h()}),(a=document.getElementById("toggle-label-manager"))==null||a.addEventListener("click",()=>{const r=document.getElementById("label-manager-overlay");r&&(r.hidden=!r.hidden)}),(t=document.getElementById("close-label-manager"))==null||t.addEventListener("click",()=>{const r=document.getElementById("label-manager-overlay");r&&(r.hidden=!0)}),(n=document.getElementById("label-manager-overlay"))==null||n.addEventListener("click",r=>{r.target===r.currentTarget&&(r.currentTarget.hidden=!0)}),(o=document.getElementById("create-label-form"))==null||o.addEventListener("submit",async r=>{r.preventDefault();const l=r.currentTarget,s=l.elements.name.value.trim(),d=l.elements.color.value,b=document.getElementById("create-label-error");if(b.hidden=!0,!s)return;const $=await B(s,d);$?(b.textContent=$,b.hidden=!1):l.elements.name.value=""}),(i=document.getElementById("label-list"))==null||i.addEventListener("click",async r=>{const l=r.target.closest("[data-action]");if(!l)return;const s=l.dataset.action,d=l.dataset.labelId;if(s==="delete-label"){if(!confirm("Delete this label? It will be removed from all cards."))return;await A(d)}if(s==="edit-label"){const b=u.find($=>$.id===d);if(!b)return;T(d,b)}}),document.querySelectorAll('[data-action="open-assign"]').forEach(r=>{r.addEventListener("click",l=>{l.stopPropagation();const s=r.dataset.cardId,d=document.querySelector(".assign-popover");d&&d.dataset.popoverCardId===s?S():P(s,r)})})}function T(e,a){const t=document.querySelector(`.lm-row[data-label-id="${e}"]`);t&&(t.innerHTML=`
    <form class="lm-edit-form" data-label-id="${c(e)}">
      <input class="lm-input" name="name" type="text" maxlength="60" value="${c(a.name)}" required autocomplete="off" />
      <input class="lm-color" name="color" type="color" value="${c(a.color)}" />
      <button class="lm-btn lm-btn--primary" type="submit">Save</button>
      <button class="lm-btn" type="button" data-action="cancel-edit">Cancel</button>
    </form>
    <p class="lm-error" id="edit-label-error-${c(e)}" hidden></p>
  `,t.querySelector('[data-action="cancel-edit"]').addEventListener("click",()=>{t.innerHTML=x(a).trim(),t.querySelector('[data-action="edit-label"]').addEventListener("click",()=>T(e,a)),t.querySelector('[data-action="delete-label"]').addEventListener("click",async()=>{confirm("Delete this label? It will be removed from all cards.")&&await A(e)})}),t.querySelector(".lm-edit-form").addEventListener("submit",async n=>{n.preventDefault();const o=n.currentTarget,i=o.elements.name.value.trim(),r=o.elements.color.value,l=document.getElementById(`edit-label-error-${e}`);l.hidden=!0;const s=await H(e,i,r);s&&(l.textContent=s,l.hidden=!1)}))}async function B(e,a){try{const t=await fetch(`${f}/api/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:e,color:a})});return t.ok?null:(await t.json()).error||"Failed to create label"}catch(t){return t.message}}async function H(e,a,t){try{const n=await fetch(`${f}/api/labels/${e}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:a,color:t})});return n.ok?null:(await n.json()).error||"Failed to update label"}catch(n){return n.message}}async function A(e){try{const a=await fetch(`${f}/api/labels/${e}`,{method:"DELETE"});if(!a.ok){const t=await a.json();m(`Delete failed: ${t.error||"unknown error"}`,!0)}}catch(a){m(`Delete failed: ${a.message}`,!0)}}async function F(e,a){try{const t=await fetch(`${f}/api/cards/${e}/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({labelId:a})});if(!t.ok){const n=await t.json();m(`Assign failed: ${n.error||"unknown error"}`,!0)}}catch(t){m(`Assign failed: ${t.message}`,!0)}}async function J(e,a){try{const t=await fetch(`${f}/api/cards/${e}/labels/${a}`,{method:"DELETE"});if(!t.ok){const n=await t.json();m(`Unassign failed: ${n.error||"unknown error"}`,!0)}}catch(t){m(`Unassign failed: ${t.message}`,!0)}}async function R(e,a){try{const t=await fetch(`${f}/api/cards`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:e,text:a})});if(!t.ok)throw new Error((await t.json()).error||"Create failed")}catch(t){m(`Create failed: ${t.message}`,!0)}}async function U(e,a,t,n){try{const o=await fetch(`${f}/api/cards/${e}/move`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:a,beforeId:t,afterId:n})});if(!o.ok)throw new Error((await o.json()).error||"Move failed")}catch(o){m(`Move failed: ${o.message}`,!0)}}function z(e,a){const t=[...e.querySelectorAll(".card")].map(o=>o.dataset.cardId),n=t.indexOf(a);return{afterId:n>0?t[n-1]:null,beforeId:n>=0&&n<t.length-1?t[n+1]:null}}function K(e,a,t,n){const o=I(e);if(!o)return;const i=v.columns.find(d=>d.id===a);if(!i)return;const r=n?i.cards.findIndex(d=>d.id===n):-1,l=t?i.cards.findIndex(d=>d.id===t):-1;let s=i.cards.length;r!==-1?s=r+1:l!==-1&&(s=l),i.cards.splice(s,0,{...o,column_id:a,optimistic:!0})}function X(e){if(e.board){v=w(e.board),h(),m("Synced");return}if(!e.card)return;const a=e.card;I(a.id);const t=v.columns.find(n=>n.id===a.column_id||n.id===e.columnId);t&&(t.cards.push({...a,labels:a.labels||[]}),t.cards.sort(k),h(),m("Synced"))}function Y(e){switch(e.board&&(v=w(e.board)),e.type){case"label-create":{u.find(a=>a.id===e.label.id)||(u.push(e.label),u.sort((a,t)=>a.name.localeCompare(t.name)));break}case"label-update":{const a=u.findIndex(t=>t.id===e.label.id);a!==-1?u[a]=e.label:u.push(e.label),u.sort((t,n)=>t.name.localeCompare(n.name));break}case"label-delete":{u=u.filter(a=>a.id!==e.labelId),g.delete(e.labelId);break}}h(),m("Synced")}async function G(){const[e,a]=await Promise.all([fetch(`${f}/api/board`),fetch(`${f}/api/labels`)]);if(!e.ok)throw new Error("Could not load board");if(!a.ok)throw new Error("Could not load labels");v=w(await e.json()),u=await a.json(),h()}function Q(){p==null||p.close(),p=new EventSource(`${f}/api/stream`),p.addEventListener("connected",()=>m("Live")),p.addEventListener("mutation",e=>{X(JSON.parse(e.data))}),p.addEventListener("label-mutation",e=>{Y(JSON.parse(e.data))}),p.onerror=()=>m("Reconnecting…",!0)}function m(e,a=!1){const t=document.querySelector("#status");t&&(t.textContent=e,t.classList.toggle("warn",a)),clearTimeout(C),a&&(C=setTimeout(()=>m((p==null?void 0:p.readyState)===EventSource.OPEN?"Live":"Reconnecting…"),4e3))}async function V(){L.innerHTML='<div class="loading">Loading board…</div>';try{await G(),Q()}catch(e){L.innerHTML=`<div class="loading error">${c(e.message)}</div>`}}V();
