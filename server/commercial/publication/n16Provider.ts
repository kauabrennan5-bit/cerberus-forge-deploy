import type { PublicationPayload } from "./n16Contract";

export type PublicationProviderStatus = "PUBLISHED" | "FAILED" | "AMBIGUOUS";

export interface PublicationProviderValidation {
  ok: boolean;
  reason?: string;
}

export interface PublicationProviderPublishResult {
  ok: boolean;
  status: PublicationProviderStatus;
  provider_reference?: string | null;
  error?: string;
}

export interface PublicationProviderConfirmation {
  status: PublicationProviderStatus;
  provider_reference?: string | null;
  error?: string;
}

export interface PublicationProvider {
  validatePayload(payload: PublicationPayload, destination: string): Promise<PublicationProviderValidation>;
  publish(payload: PublicationPayload, destination: string, executionKey: string): Promise<PublicationProviderPublishResult>;
  getStatus(providerReference: string | null, executionKey: string): Promise<PublicationProviderConfirmation>;
}

export type FakePublicationProviderMode = "success" | "failure" | "ambiguous";

export class FakePublicationProvider implements PublicationProvider {
  public validateCalls = 0;
  public publishCalls = 0;
  public statusCalls = 0;
  public readonly mode: FakePublicationProviderMode;
  public readonly reference: string;

  constructor(mode: FakePublicationProviderMode = "success", reference = "fake-pub-ref") {
    this.mode = mode;
    this.reference = reference;
  }

  async validatePayload(payload: PublicationPayload, destination: string): Promise<PublicationProviderValidation> {
    this.validateCalls += 1;
    if (!payload || !destination) return { ok: false, reason: "invalid_provider_input" };
    return { ok: true };
  }

  async publish(_payload: PublicationPayload, _destination: string, _executionKey: string): Promise<PublicationProviderPublishResult> {
    this.publishCalls += 1;
    if (this.mode === "failure") return { ok: false, status: "FAILED", error: "fake_provider_failure" };
    if (this.mode === "ambiguous") return { ok: false, status: "AMBIGUOUS", provider_reference: this.reference, error: "fake_provider_ambiguous" };
    return { ok: true, status: "PUBLISHED", provider_reference: this.reference };
  }

  async getStatus(providerReference: string | null, _executionKey: string): Promise<PublicationProviderConfirmation> {
    this.statusCalls += 1;
    if (this.mode === "failure") return { status: "FAILED", provider_reference: providerReference, error: "fake_provider_failure_confirmed" };
    if (this.mode === "ambiguous") return { status: "AMBIGUOUS", provider_reference: providerReference, error: "fake_provider_status_ambiguous" };
    return { status: "PUBLISHED", provider_reference: providerReference ?? this.reference };
  }
}
