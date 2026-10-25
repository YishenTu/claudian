export type GrokSessionNotificationSource = 'extension' | 'standard';

interface MirrorCandidate {
  fingerprint: string;
  source: GrokSessionNotificationSource;
}

export class GrokSessionNotificationMirrorDeduplicator {
  private candidate: MirrorCandidate | null = null;

  shouldProcess(notification: object, source: GrokSessionNotificationSource): boolean {
    const fingerprint = JSON.stringify(notification);
    if (this.candidate?.fingerprint === fingerprint && this.candidate.source !== source) {
      this.candidate = null;
      return false;
    }
    this.candidate = { fingerprint, source };
    return true;
  }

  reset(): void {
    this.candidate = null;
  }
}
