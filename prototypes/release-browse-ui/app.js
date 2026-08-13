const releases = [
  { day: 1, series: "Witch Hat Atelier", volume: "Vol. 14", publisher: "Kodansha", format: "physical", followed: true, color: "#315f59" },
  { day: 1, series: "The Summer Hikaru Died", volume: "Vol. 6", publisher: "Yen Press", format: "digital", followed: false, color: "#796254" },
  { day: 3, series: "Dandadan", volume: "Vol. 16", publisher: "VIZ Media", format: "physical", followed: true, color: "#cb583e" },
  { day: 4, series: "Blue Box", volume: "Vol. 13", publisher: "VIZ Media", format: "digital", followed: false, color: "#4686a5" },
  { day: 6, series: "Medalist", volume: "Vol. 12", publisher: "Kodansha", format: "digital", followed: true, color: "#4f70a8" },
  { day: 6, series: "A Sign of Affection", volume: "Vol. 11", publisher: "Kodansha", format: "physical", followed: false, color: "#b86a7d" },
  { day: 7, series: "Smoking Behind the Supermarket", volume: "Vol. 5", publisher: "Square Enix", format: "physical", followed: true, color: "#32685a" },
  { day: 8, series: "Kaiju No. 8", volume: "Vol. 14", publisher: "VIZ Media", format: "digital", followed: true, color: "#5a6654" },
  { day: 10, series: "The Moon on a Rainy Night", volume: "Vol. 8", publisher: "Kodansha", format: "physical", followed: false, color: "#344b75" },
  { day: 11, series: "Frieren: Beyond Journey's End", volume: "Vol. 13", publisher: "VIZ Media", format: "physical", followed: true, color: "#4d6d64" },
  { day: 11, series: "Frieren: Beyond Journey's End", volume: "Vol. 13", publisher: "VIZ Media", format: "digital", followed: true, color: "#70837d" },
  { day: 13, series: "Delicious in Dungeon", volume: "World Guide", publisher: "Yen Press", format: "physical", followed: false, color: "#927242" },
  { day: 14, series: "My Happy Marriage", volume: "Vol. 6", publisher: "Square Enix", format: "digital", followed: false, color: "#8c6585" },
  { day: 15, series: "Chainsaw Man", volume: "Vol. 18", publisher: "VIZ Media", format: "physical", followed: true, color: "#a23f32" },
  { day: 17, series: "Go! Go! Loser Ranger!", volume: "Vol. 14", publisher: "Kodansha", format: "digital", followed: false, color: "#b05b3d" },
  { day: 18, series: "The Apothecary Diaries", volume: "Vol. 14", publisher: "Square Enix", format: "physical", followed: true, color: "#526b3e" },
  { day: 20, series: "She Loves to Cook, and She Loves to Eat", volume: "Vol. 6", publisher: "Yen Press", format: "physical", followed: true, color: "#b8634c" },
  { day: 21, series: "Initial D Omnibus", volume: "Vol. 7", publisher: "Kodansha", format: "physical", followed: false, color: "#4a4b4f" },
  { day: 22, series: "Sakamoto Days", volume: "Vol. 18", publisher: "VIZ Media", format: "digital", followed: true, color: "#366b69" },
  { day: 24, series: "Otherside Picnic", volume: "Vol. 13", publisher: "Square Enix", format: "digital", followed: false, color: "#6b5e89" },
  { day: 25, series: "A Bride's Story", volume: "Vol. 15", publisher: "Yen Press", format: "physical", followed: true, color: "#8b6447" },
  { day: 27, series: "Mobile Suit Gundam Thunderbolt", volume: "Vol. 24", publisher: "VIZ Media", format: "physical", followed: false, color: "#48566b" },
  { day: 29, series: "Wind Breaker", volume: "Vol. 10", publisher: "Kodansha", format: "digital", followed: true, color: "#4d7078" },
  { day: 30, series: "The Guy She Was Interested In", volume: "Vol. 2", publisher: "Yen Press", format: "physical", followed: true, color: "#497149" }
];

const variants = {
  A: { name: "Month grid", render: renderCalendar },
  B: { name: "Release agenda", render: renderAgenda },
  C: { name: "Publisher lanes", render: renderLanes }
};

const state = { format: "all", publisher: "all", followed: false };
const app = document.querySelector("#app");
const params = new URLSearchParams(window.location.search);
let currentVariant = variants[params.get("variant")] ? params.get("variant") : "A";

function filteredReleases() {
  return releases.filter((release) =>
    (state.format === "all" || release.format === state.format) &&
    (state.publisher === "all" || release.publisher === state.publisher) &&
    (!state.followed || release.followed)
  );
}

function filters() {
  const publishers = [...new Set(releases.map((release) => release.publisher))];
  return `
    <div class="filter-row">
      <label class="select-wrap">
        <span class="sr-only">Format</span>
        <select data-filter="format">
          <option value="all" ${state.format === "all" ? "selected" : ""}>All formats</option>
          <option value="physical" ${state.format === "physical" ? "selected" : ""}>Physical</option>
          <option value="digital" ${state.format === "digital" ? "selected" : ""}>Digital</option>
        </select>
      </label>
      <label class="select-wrap">
        <span class="sr-only">Publisher</span>
        <select data-filter="publisher">
          <option value="all" ${state.publisher === "all" ? "selected" : ""}>All publishers</option>
          ${publishers.map((publisher) => `<option value="${publisher}" ${state.publisher === publisher ? "selected" : ""}>${publisher}</option>`).join("")}
        </select>
      </label>
      <label class="follow-toggle">
        <input type="checkbox" data-filter="followed" ${state.followed ? "checked" : ""} /> Followed series
      </label>
    </div>
  `;
}

function cover(release) {
  return `<div class="cover" style="background:${release.color}"><span>${release.series}</span></div>`;
}

function badge(release) {
  return `<span class="format-badge ${release.format}">${release.format}</span>`;
}

function resultCount(items) {
  return `<span class="result-count">Showing ${items.length} of ${releases.length} releases</span>`;
}

function renderCalendar() {
  const items = filteredReleases();
  const byDay = groupBy(items, (release) => release.day);
  const cells = [];
  for (let day = 27; day <= 30; day += 1) cells.push({ day, outside: true });
  for (let day = 1; day <= 31; day += 1) cells.push({ day, outside: false });

  app.innerHTML = `
    <section class="page-shell">
      <div class="calendar-topline">
        <div>
          <span class="eyebrow">English releases</span>
          <h1>October 2026</h1>
        </div>
        <div class="month-nav"><button class="icon-button" aria-label="Previous month">←</button><button class="soft-button">Today</button><button class="icon-button" aria-label="Next month">→</button></div>
      </div>
      <p class="page-intro">Scan the month at a glance. Each release sits on its publication date; select one for edition details.</p>
      <div class="calendar-toolbar">${filters()}${resultCount(items)}</div>
      <div class="calendar-grid">
        ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => `<div class="weekday">${day}</div>`).join("")}
        ${cells.map((cell) => {
          const dayItems = cell.outside ? [] : (byDay[cell.day] || []);
          return `<div class="calendar-day ${cell.outside ? "outside" : ""}">
            <div class="day-number"><span>${cell.day}</span>${dayItems.length ? `<span class="day-count">${dayItems.length}</span>` : ""}</div>
            ${dayItems.slice(0, 2).map((release) => `<button class="calendar-item" style="--accent:${release.color}" title="${release.series} ${release.volume}"><strong>${release.followed ? '<span class="follow-star">★</span> ' : ""}${release.series}</strong><span>${release.volume} · ${release.format === "physical" ? "Print" : "Digital"}</span></button>`).join("")}
            ${dayItems.length > 2 ? `<span class="calendar-more">+${dayItems.length - 2} more</span>` : ""}
          </div>`;
        }).join("")}
      </div>
    </section>`;
}

function renderAgenda() {
  const items = filteredReleases();
  const byDay = groupBy(items, (release) => release.day);
  app.innerHTML = `
    <section class="agenda-shell">
      <div class="agenda-hero">
        <span class="eyebrow">Release agenda</span>
        <h1>Your month in manga.</h1>
        <p>A chronological reading list built for browsing covers and details, one release day at a time.</p>
        ${filters()}
      </div>
      <div class="agenda-summary"><h2>October 2026</h2>${resultCount(items)}</div>
      ${items.length ? Object.entries(byDay).map(([day, dayItems]) => `
        <section class="agenda-group">
          <div class="agenda-date"><strong>${day}</strong><span>${weekdayFor(Number(day))}</span></div>
          <div class="agenda-items">
            ${dayItems.map((release) => `<article class="agenda-card">
              ${cover(release)}
              <div><h3>${release.followed ? '<span class="follow-star" aria-label="Followed series">★</span> ' : ""}${release.series} — ${release.volume}</h3><p>English release · October ${release.day}, 2026</p></div>
              <div class="agenda-meta">${badge(release)}<span class="publisher">${release.publisher}</span></div>
            </article>`).join("")}
          </div>
        </section>`).join("") : `<div class="empty-state">No releases match these filters.</div>`}
    </section>`;
}

function renderLanes() {
  const items = filteredReleases();
  const publishers = state.publisher === "all"
    ? [...new Set(releases.map((release) => release.publisher))]
    : [state.publisher];
  const weeks = [
    { label: "Sep 28–Oct 4", from: 1, to: 4 },
    { label: "Oct 5–11", from: 5, to: 11 },
    { label: "Oct 12–18", from: 12, to: 18 },
    { label: "Oct 19–25", from: 19, to: 25 },
    { label: "Oct 26–Nov 1", from: 26, to: 31 }
  ];

  app.innerHTML = `
    <section class="lanes-shell">
      <div class="lanes-masthead">
        <div class="lanes-titlebar">
          <div><span class="eyebrow">Release radar</span><h1>October, by publisher</h1></div>
          <div class="month-nav"><button class="icon-button" aria-label="Previous month">←</button><button class="soft-button">October 2026</button><button class="icon-button" aria-label="Next month">→</button></div>
        </div>
        <div class="lanes-controls">${filters()}<div class="lanes-legend">${badge({format:"physical"})}${badge({format:"digital"})}${resultCount(items)}</div></div>
      </div>
      <div class="lanes-board">
        <div class="lanes-board-inner">
          <div class="week-header"><div>Publisher</div>${weeks.map((week, index) => `<div class="${index === 2 ? "week-now" : ""}">${week.label}</div>`).join("")}</div>
          ${publishers.map((publisher) => {
            const publisherItems = items.filter((release) => release.publisher === publisher);
            return `<section class="publisher-lane">
              <div class="lane-label"><strong>${publisher}</strong><span>${publisherItems.length} releases</span></div>
              ${weeks.map((week, index) => `<div class="lane-cell ${index === 2 ? "current" : ""}">
                ${publisherItems.filter((release) => release.day >= week.from && release.day <= week.to).map((release) => `<article class="lane-release">${cover(release)}<div><strong>${release.followed ? '<span class="follow-star">★</span> ' : ""}${release.series}</strong><small>${release.volume} · Oct ${release.day}</small><small>${release.format === "physical" ? "Print" : "Digital"}</small></div></article>`).join("")}
              </div>`).join("")}
            </section>`;
          }).join("")}
          ${items.length ? "" : `<div class="empty-state">No releases match these filters.</div>`}
        </div>
      </div>
    </section>`;
}

function weekdayFor(day) {
  return new Intl.DateTimeFormat("en", { weekday: "short" }).format(new Date(2026, 9, day));
}

function groupBy(items, keyFor) {
  return items.reduce((groups, item) => {
    const key = keyFor(item);
    (groups[key] ||= []).push(item);
    return groups;
  }, {});
}

function bindFilters() {
  document.querySelectorAll("[data-filter]").forEach((control) => {
    control.addEventListener("change", (event) => {
      const key = event.target.dataset.filter;
      state[key] = event.target.type === "checkbox" ? event.target.checked : event.target.value;
      render();
    });
  });
}

function render() {
  variants[currentVariant].render();
  document.querySelector("#variant-label").textContent = `${currentVariant} — ${variants[currentVariant].name}`;
  bindFilters();
}

function moveVariant(offset) {
  const keys = Object.keys(variants);
  const nextIndex = (keys.indexOf(currentVariant) + offset + keys.length) % keys.length;
  currentVariant = keys[nextIndex];
  const url = new URL(window.location);
  url.searchParams.set("variant", currentVariant);
  window.history.replaceState({}, "", url);
  render();
}

document.querySelector("#previous-variant").addEventListener("click", () => moveVariant(-1));
document.querySelector("#next-variant").addEventListener("click", () => moveVariant(1));
window.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target.matches("input, textarea, select, [contenteditable]")) return;
  if (event.key === "ArrowLeft") moveVariant(-1);
  if (event.key === "ArrowRight") moveVariant(1);
});

render();
