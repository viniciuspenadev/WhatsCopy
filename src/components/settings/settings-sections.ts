import {
  Coins,
  FileText,
  KeyRound,
  LayoutGrid,
  Palette,
  PlugZap,
  QrCode,
  Shield,
  Sparkles,
  Tags,
  User,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'connect',
  'api-offer',
  'whatsapp',
  'templates',
  'fields',
  'deals',
  'members',
  'api',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/**
 * Sections temporarily hidden from the rail + overview while the product
 * is in RedirectFlow test mode (Meta WhatsApp config + template manager
 * aren't used right now — connection is via the Evolution QR tab). They
 * stay in the union/panel so nothing breaks; they're just not navigable.
 */
export const HIDDEN_SECTIONS: ReadonlySet<SettingsSection> = new Set([
  'whatsapp',
  'templates',
]);

export const VISIBLE_SECTIONS = SETTINGS_SECTIONS.filter(
  (s) => !HIDDEN_SECTIONS.has(s),
);

/** Rail grouping. `adminOnly` items are hidden for non-admins. */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'Overview', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', label: 'Your profile', icon: User, group: 'account' },
  security: { id: 'security', label: 'Login & security', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', label: 'Appearance', icon: Palette, group: 'account' },
  connect: { id: 'connect', label: 'WhatsApp QR Code', icon: QrCode, group: 'workspace' },
  'api-offer': { id: 'api-offer', label: 'IA / Ofertas', icon: Sparkles, group: 'workspace' },
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', icon: PlugZap, group: 'workspace' },
  templates: { id: 'templates', label: 'Templates', icon: FileText, group: 'workspace' },
  fields: { id: 'fields', label: 'Fields & tags', icon: Tags, group: 'workspace' },
  deals: { id: 'deals', label: 'Deals & currency', icon: Coins, group: 'workspace' },
  members: { id: 'members', label: 'Team members', icon: UsersRound, group: 'workspace' },
  api: { id: 'api', label: 'API keys', icon: KeyRound, group: 'workspace' },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Account', group: 'account' },
  { label: 'Workspace', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section). Anything unknown falls back to the
 * Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  // Hidden during test mode — old links land somewhere sensible.
  if (raw === 'whatsapp') return 'connect';
  if (raw === 'templates') return DEFAULT_SECTION;
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
