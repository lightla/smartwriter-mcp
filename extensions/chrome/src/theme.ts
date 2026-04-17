/**
 * Theme tokens for Smartwriter MCP Chrome Extension.
 * Soft graphite palette with high-contrast non-white text.
 */
export const theme = {
  // Layout
  popup: 'w-[280px] overflow-hidden rounded-none bg-[#cee1de] text-[#102221] shadow-none',
  contentFrame: 'overflow-hidden bg-[#cee1de]',

  // Header
  header: 'flex items-center justify-between bg-[#789891] px-3 py-3',
  headerTitle: 'text-[17px] font-black leading-5 text-[#061918]',
  headerSub: 'mt-1 text-xs font-bold text-[#16312e]',
  headerAccent: 'text-[#116466]',

  // Sections
  section: 'border-b border-[#9eb8b3] bg-[#cee1de] px-3 py-3',
  sectionAlt: 'border-t border-[#9eb8b3] bg-[#cee1de] px-3 py-3',

  // Text
  textPrimary: 'text-[#162424]',
  textSecondary: 'text-[#263b3b]',
  textMuted: 'text-[#566965]',
  textFaint: 'text-[#5f706c]',
  textAccent: 'text-[#116466]',
  textSuccess: 'text-[#12613b]',
  textWarning: 'text-[#8a5a00]',
  textDanger: 'text-[#a33a35]',

  // Status dots
  dotConnected: 'bg-[#168a55]',
  dotConnecting: 'bg-[#c17a00] animate-pulse',
  dotWaiting: 'bg-[#c17a00] animate-pulse',

  // Skeleton
  skeleton: 'animate-pulse rounded bg-[#d1dad4]',
} as const;
