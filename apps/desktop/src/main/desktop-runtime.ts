import { VoivoxService, type CaptureSession, type CaptureSource } from '@voivox/core';

export class DesktopRuntime {
  private readonly service: VoivoxService;

  constructor(service = new VoivoxService()) {
    this.service = service;
  }

  startCapture(source: CaptureSource): CaptureSession {
    return this.service.startCapture(source);
  }

  stopCapture(sessionId: string): CaptureSession {
    return this.service.stopCapture(sessionId);
  }

  appendDemoSegment(sessionId: string): void {
    this.service.appendRawSegment(sessionId, {
      startMs: 0,
      endMs: 1_200,
      text: 'VOIVOX 已收到一段本机测试转写。'
    });
  }

  getDashboard(): { activeSession: CaptureSession | undefined; sessions: CaptureSession[] } {
    return {
      activeSession: this.service.getActiveSession(),
      sessions: this.service.listSessions()
    };
  }

  getService(): VoivoxService {
    return this.service;
  }
}
