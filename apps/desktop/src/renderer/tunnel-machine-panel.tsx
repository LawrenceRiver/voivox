import type { PvttStatus, TranscriptSegment, TranscriptionMode } from '@voivox/core';
import { TunnelMachine, type TunnelLocale } from '@voivox/ui';

export type TunnelMachinePanelProps = {
  locale: TunnelLocale;
  state: PvttStatus;
  source?: { title: string; url?: string };
  mode: TranscriptionMode;
  segments: TranscriptSegment[];
  transcript: string;
  onModeChange: (mode: TranscriptionMode) => void;
  onPrimaryAction: () => void;
  onStop: () => void;
  onCopy: () => void;
  onClear: () => void;
  onRetry: () => void;
  onTargetDrop: () => void;
};

export function TunnelMachinePanel(props: TunnelMachinePanelProps) {
  return <TunnelMachine size="full" {...props} />;
}
