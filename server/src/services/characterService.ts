import type { CharacterSheet } from '../domain/types.js';

export function createStarterCharacter(name: string): CharacterSheet {
  return {
    name,
    species: '人类',
    subSpecies: '标准人类',
    className: '战士',
    classDetail: '防御型战士',
    level: 1,
    abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
    hitPoints: { current: 12, max: 12 },
    armorClass: 16,
    proficiencyBonus: 2,
    skills: ['Athletics', 'Perception'],
    equipment: ['Longsword', 'Shield', 'Explorer Pack'],
    spells: [],
    languages: [],
    proficiencies: [],
    privateNotes: ''
  };
}

export function createEmptyCharacterBuilderSheet(name: string): CharacterSheet {
  return {
    name,
    species: '',
    subSpecies: '',
    className: '',
    classDetail: '',
    level: 1,
    abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    hitPoints: { current: 1, max: 1 },
    armorClass: 10,
    proficiencyBonus: 2,
    skills: [],
    equipment: [],
    spells: [],
    languages: [],
    proficiencies: [],
    privateNotes: '',
    builderDraft: {
      name,
      concept: '',
      species: '',
      subSpecies: '',
      className: '',
      classDetail: '',
      background: '',
      abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      skills: [],
      equipment: [],
      spells: [],
      languages: [],
      proficiencies: [],
      personality: '',
      ideal: '',
      bond: '',
      flaw: '',
      notes: '',
    },
  };
}
