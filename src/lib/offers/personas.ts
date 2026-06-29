/**
 * Offer copy personas.
 *
 * Each persona is a target audience the AI copy is tuned for. The
 * `promptFragment` is injected into the user prompt so the model adapts
 * tone, emojis and persuasion triggers. Pure module (no React) so it can
 * be imported by both the API route and the UI — the UI maps `key` to a
 * lucide icon on its own.
 */

export type OfferPersonaKey =
  | 'padrao'
  | 'maes'
  | 'pet'
  | 'beleza'
  | 'homens'
  | 'fitness'

export interface OfferPersona {
  key: OfferPersonaKey
  /** Short PT-BR label shown on the persona card. */
  label: string
  /** One-line description for the card. */
  description: string
  /** Injected into the prompt to steer tone/emojis/triggers. */
  promptFragment: string
}

export const OFFER_PERSONAS: OfferPersona[] = [
  {
    key: 'padrao',
    label: 'Padrão',
    description: 'Tom equilibrado, serve para qualquer público.',
    promptFragment:
      'Público geral. Tom amigável e direto, sem exageros. Use 2-4 emojis bem colocados e gatilhos de urgência leves (estoque/preço).',
  },
  {
    key: 'maes',
    label: 'Mães',
    description: 'Praticidade, economia e cuidado com a família.',
    promptFragment:
      'Público de mães. Tom acolhedor e prático; destaque economia, praticidade no dia a dia e benefício para a família/casa. Emojis: 👶🏠💚.',
  },
  {
    key: 'pet',
    label: 'Pet',
    description: 'Donos de pets — carinho e bem-estar do animal.',
    promptFragment:
      'Público de donos de pets. Tom carinhoso e divertido; destaque conforto, saúde e felicidade do pet. Emojis: 🐶🐱🐾.',
  },
  {
    key: 'beleza',
    label: 'Beleza/Moda',
    description: 'Estilo, autoestima e tendência.',
    promptFragment:
      'Público de beleza e moda. Tom aspiracional e estiloso; destaque autoestima, tendência e transformação. Emojis: ✨💅👗.',
  },
  {
    key: 'homens',
    label: 'Homens',
    description: 'Objetivo, performance e custo-benefício.',
    promptFragment:
      'Público masculino. Tom objetivo e confiante; destaque performance, durabilidade e custo-benefício. Poucos emojis (🔥💪⚡), sem firula.',
  },
  {
    key: 'fitness',
    label: 'Fitness',
    description: 'Resultado, energia e superação.',
    promptFragment:
      'Público fitness. Tom motivador e energético; destaque resultado, disposição e superação. Emojis: 💪🏋️🔥.',
  },
]

const PERSONA_KEYS = new Set(OFFER_PERSONAS.map((p) => p.key))

export function isOfferPersona(value: unknown): value is OfferPersonaKey {
  return typeof value === 'string' && PERSONA_KEYS.has(value as OfferPersonaKey)
}

export function getPersona(key: string): OfferPersona {
  return OFFER_PERSONAS.find((p) => p.key === key) ?? OFFER_PERSONAS[0]
}
