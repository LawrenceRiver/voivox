export type TargetSessionStatus =
  | 'armed'
  | 'dragging'
  | 'targeted'
  | 'ready'
  | 'awaiting-user-play'
  | 'capturing'
  | 'paused'
  | 'transcribing'
  | 'completed'
  | 'error';

export type TargetRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TargetPoint = { x: number; y: number };

export type VideoTarget = {
  id: string;
  kind: 'html-media' | 'embedded-player' | 'tab-audio';
  tag?: 'video' | 'audio';
  frameId: number;
  documentId: string;
  viewportRect: TargetRect;
  screenRect: TargetRect;
  activationPoint: TargetPoint;
  canDirectPlay: boolean;
};

export type TargetSession = {
  schemaVersion: 1;
  id: string;
  tabId: number;
  windowId: number;
  frameId: number;
  documentId: string;
  pageOrigin: string;
  url: string;
  title: string;
  dropNonce: string;
  dropToken: string;
  status: TargetSessionStatus;
  target?: VideoTarget;
  armedAt: number;
  updatedAt: number;
  lastCommandId?: string;
  tunnelSessionId?: string;
};

export type TargetSessionPatch = Partial<Omit<
  TargetSession,
  | 'schemaVersion'
  | 'id'
  | 'tabId'
  | 'windowId'
  | 'frameId'
  | 'documentId'
  | 'dropNonce'
  | 'dropToken'
  | 'armedAt'
>>;

const STATUS_VALUES = new Set<TargetSessionStatus>([
  'armed',
  'dragging',
  'targeted',
  'ready',
  'awaiting-user-play',
  'capturing',
  'paused',
  'transcribing',
  'completed',
  'error'
]);

const SESSION_KEYS = new Set([
  'schemaVersion', 'id', 'tabId', 'windowId', 'frameId', 'documentId',
  'pageOrigin', 'url', 'title', 'dropNonce', 'dropToken', 'status', 'target',
  'armedAt', 'updatedAt', 'lastCommandId', 'tunnelSessionId'
]);

const TARGET_KEYS = new Set([
  'id', 'kind', 'tag', 'frameId', 'documentId', 'viewportRect', 'screenRect',
  'activationPoint', 'canDirectPlay'
]);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isTargetSession(value: unknown): value is TargetSession {
  if (!isRecord(value) || hasUnknownKeys(value, SESSION_KEYS)) return false;
  if (value.schemaVersion !== 1 || !isNonEmpty(value.id) || !UUID_V4.test(value.id)) return false;
  if (!isNonNegativeInteger(value.tabId) || !isNonNegativeInteger(value.windowId) || !isNonNegativeInteger(value.frameId)) return false;
  if (![value.documentId, value.pageOrigin, value.url, value.title, value.dropNonce, value.dropToken].every(isNonEmpty)) return false;
  if (!STATUS_VALUES.has(value.status as TargetSessionStatus)) return false;
  if (!isFiniteTimestamp(value.armedAt) || !isFiniteTimestamp(value.updatedAt) || value.updatedAt < value.armedAt) return false;
  if (value.lastCommandId !== undefined && !isNonEmpty(value.lastCommandId)) return false;
  if (value.tunnelSessionId !== undefined && !isNonEmpty(value.tunnelSessionId)) return false;
  if (value.target !== undefined) {
    if (!isVideoTarget(value.target)) return false;
    if (value.target.frameId !== value.frameId || value.target.documentId !== value.documentId) return false;
  }
  return true;
}

export function isVideoTarget(value: unknown): value is VideoTarget {
  if (!isRecord(value) || hasUnknownKeys(value, TARGET_KEYS)) return false;
  if (!isNonEmpty(value.id)) return false;
  if (value.kind !== 'html-media' && value.kind !== 'embedded-player' && value.kind !== 'tab-audio') return false;
  if (value.tag !== undefined && value.tag !== 'video' && value.tag !== 'audio') return false;
  if (!isNonNegativeInteger(value.frameId) || !isNonEmpty(value.documentId)) return false;
  return isRect(value.viewportRect)
    && isRect(value.screenRect)
    && isPoint(value.activationPoint)
    && typeof value.canDirectPlay === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRect(value: unknown): value is TargetRect {
  if (!isRecord(value) || hasUnknownKeys(value, new Set(['x', 'y', 'width', 'height']))) return false;
  return isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isFiniteNumber(value.width) && value.width >= 0
    && isFiniteNumber(value.height) && value.height >= 0;
}

function isPoint(value: unknown): value is TargetPoint {
  return isRecord(value)
    && !hasUnknownKeys(value, new Set(['x', 'y']))
    && isFiniteNumber(value.x)
    && isFiniteNumber(value.y);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
