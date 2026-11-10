export const INJURY_TYPES = Object.freeze([
  { id: 'bleeding', label: 'Wounds & bleeding', chinese: '傷口／流血', description: 'Cuts, wounds or bleeding.' },
  { id: 'fracture', label: 'Fractures / dislocations', chinese: '骨折／脫臼', description: 'A broken bone or injured joint.' },
  { id: 'burns', label: 'Burns / scalds', chinese: '燒傷／燙傷', description: 'Skin hurt by fire, heat or hot water.' },
  { id: 'smoke_inhalation', label: 'Smoke inhalation', chinese: '吸入濃煙', description: 'Breathed in smoke.' },
]);

export const emptyInjuryCounts = () => Object.fromEntries(INJURY_TYPES.map(type => [type.id, 0]));
export const reportInjuries = report => report?.status === 'help' && Array.isArray(report.injuries)
  ? INJURY_TYPES.filter(type => report.injuries.includes(type.id)).map(type => type.id) : [];
export const injuryLabels = injuries => INJURY_TYPES.filter(type => injuries?.includes(type.id)).map(type => type.label).join(', ');
