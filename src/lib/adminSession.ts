let adminPasswordInMemory = '';

/**
 * Ephemeral admin credential for the current page lifetime only.
 * Never persisted to localStorage/sessionStorage/cookies.
 */
export function setAdminSessionPassword(password: string): void {
  adminPasswordInMemory = String(password || '').trim();
}

export function getAdminSessionPassword(): string {
  return adminPasswordInMemory;
}

export function clearAdminSessionPassword(): void {
  adminPasswordInMemory = '';
}
