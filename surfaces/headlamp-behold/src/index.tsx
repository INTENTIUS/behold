/*
 * Copyright 2026 INTENTIUS
 * Licensed under the Apache License, Version 2.0.
 */

import {
  DetailsViewSectionProps,
  registerDetailsViewSection,
  registerMapSource,
  registerPluginSettings,
} from '@kinvolk/headlamp-plugin/lib';
import { NameValueTable, SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, TextField, Typography } from '@mui/material';
import { useMemo } from 'react';
import { OutsideCard } from './behold/outside-refs.js';
import { Settings, settingsStore, useExport, useHeld, WATCHED } from './held';
import { identityOfManifest, mapData, outsideFor, rowsOf, subtitleOf } from './model';

const Mark = () => (
  <svg viewBox="0 0 24 24" width="100%" height="100%" role="img" aria-label="Outside the cluster">
    <circle
      cx="12"
      cy="12"
      r="9"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeDasharray="4 3"
    />
    <circle cx="12" cy="12" r="3" fill="currentColor" />
  </svg>
);

function CardDetails({ card }: { card: OutsideCard }) {
  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h6">{card.label}</Typography>
      <Typography variant="body2" color="text.secondary" gutterBottom>
        {subtitleOf(card)}, named by a live object. No Terraform has been read for it.
      </Typography>
      <NameValueTable rows={rowsOf(card).map(([name, value]) => ({ name, value }))} />
    </Box>
  );
}

registerMapSource({
  id: 'behold-outside',
  label: 'Outside the cluster (behold)',
  icon: <Mark />,
  useData() {
    const held = useHeld();
    const exported = useExport();
    return useMemo(() => {
      if (!held) return null;
      const d = mapData(held, exported);
      return {
        nodes: d.nodes.map(n => ({
          id: n.id,
          label: n.label,
          subtitle: n.subtitle,
          icon: <Mark />,
          data: n.card,
          detailsComponent: () => <CardDetails card={n.card} />,
        })),
        edges: d.edges,
      };
    }, [held, exported]);
  },
});

function Outside({ resource }: DetailsViewSectionProps) {
  const held = useHeld();
  const exported = useExport();
  const found = useMemo(() => {
    if (!held) return null;
    const manifest = { ...resource.jsonData, kind: resource.jsonData.kind || resource.kind };
    manifest.apiVersion = manifest.apiVersion || WATCHED[manifest.kind];
    return outsideFor(held, identityOfManifest(manifest), exported);
  }, [held, exported, resource]);

  if (!found || (found.cards.length === 0 && found.notes.length === 0)) return null;
  return (
    <SectionBox title="Outside the cluster">
      {found.cards.map(c => (
        <Box key={c.id} sx={{ mb: 2 }}>
          <Typography variant="subtitle1">{c.label}</Typography>
          <Typography variant="caption" color="text.secondary">
            {subtitleOf(c)}
          </Typography>
          <NameValueTable rows={rowsOf(c).map(([name, value]) => ({ name, value }))} />
        </Box>
      ))}
      {found.notes.map((n, i) => (
        <Typography key={i} variant="body2" color="text.secondary">
          {n.path}: {n.message}
          {n.waitsOn ? ` (waits on ${n.waitsOn})` : ''}
        </Typography>
      ))}
    </SectionBox>
  );
}

registerDetailsViewSection(({ resource }: DetailsViewSectionProps) => {
  const kind = resource?.jsonData?.kind || resource?.kind;
  return kind && kind in WATCHED ? <Outside resource={resource} /> : null;
});

function SettingsForm({
  data,
  onDataChange,
}: {
  data?: Settings;
  onDataChange?: (d: Settings) => void;
}) {
  return (
    <Box sx={{ width: '100%' }}>
      <TextField
        fullWidth
        label="Export URL (optional)"
        helperText="A behold graph (behold export, or a behold serve /api/graph?detail=3). Objects it already holds get no placeholder."
        value={data?.exportUrl || ''}
        onChange={e =>
          onDataChange && onDataChange({ ...data, exportUrl: e.target.value.trim() || undefined })
        }
      />
    </Box>
  );
}

registerPluginSettings(
  'headlamp-behold',
  props => <SettingsForm data={props.data as Settings} onDataChange={props.onDataChange} />,
  true
);
void settingsStore;
