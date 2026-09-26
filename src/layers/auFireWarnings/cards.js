/** Card and legend model for Australian fire warnings. Pure — no Cesium types. */

export const AU_FIRE_OVERLAY_SOURCE_ID = 'au-fire-warnings';

/** Australian Warning System colours, plus two information tiers. */
export const AU_FIRE_LEVEL_STYLE = Object.freeze({
  emergency: Object.freeze({
    label: 'Emergency Warning',
    color: '#e3261c',
    pixelSize: 16,
  }),
  'watch-act': Object.freeze({
    label: 'Watch and Act',
    color: '#ff8a00',
    pixelSize: 14,
  }),
  advice: Object.freeze({ label: 'Advice', color: '#ffd600', pixelSize: 12 }),
  info: Object.freeze({
    label: 'Incident · no warning',
    color: '#9fb3c8',
    pixelSize: 8,
  }),
  'planned-burn': Object.freeze({
    label: 'Planned burn',
    color: '#b18cff',
    pixelSize: 8,
  }),
});

/** Most urgent first; also the draw order (urgent points paint on top). */
export const AU_FIRE_LEVEL_ORDER = Object.freeze([
  'emergency',
  'watch-act',
  'advice',
  'info',
  'planned-burn',
]);

export const isWarningLevel = (level) =>
  level === 'emergency' || level === 'watch-act' || level === 'advice';

function formatAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatHectares(ha) {
  if (!Number.isFinite(ha)) return null;
  if (ha >= 1000) return `${Math.round(ha).toLocaleString('en-AU')} ha`;
  return `${ha >= 10 ? Math.round(ha) : Math.round(ha * 10) / 10} ha`;
}

/**
 * Build the overlay-host entry for one selected incident. The caller supplies
 * `position` — this model stays JSON-safe for tests.
 */
export function buildAuFireCard(row, nowMs) {
  const style = AU_FIRE_LEVEL_STYLE[row.level] ?? AU_FIRE_LEVEL_STYLE.info;
  const facts = [row.state, row.type, formatHectares(row.sizeHa), row.status]
    .filter(Boolean)
    .join(' · ');
  const where = [row.location !== row.title ? row.location : null, row.council]
    .filter(Boolean)
    .join(' · ');
  const updated =
    row.updatedMs != null
      ? formatAge(nowMs - row.updatedMs) &&
        `updated ${formatAge(nowMs - row.updatedMs)} ago`
      : row.updatedText && `updated ${row.updatedText}`;
  const details = [
    facts,
    where,
    row.action ? `▶ ${row.action}` : null,
    row.summary,
    [updated, row.agency].filter(Boolean).join(' · '),
    row.url ? 'Official page ↗ · click card to open' : null,
  ].filter(Boolean);
  const title = `${style.label.toUpperCase()} · ${row.title}`;
  return {
    id: `au-fire-card:${row.id}`,
    selected: true,
    interactive: Boolean(row.url),
    ...(row.url ? { accessibilityLabel: `Open ${title} official page` } : {}),
    title,
    details,
    accent: style.color,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
