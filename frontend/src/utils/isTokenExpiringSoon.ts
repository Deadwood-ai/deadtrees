export const isTokenExpiringSoon = (session: any, thresholdMinutes: number = 40) => {
  if (!session || !session.expires_at) {
    return true; // If we don't have a session or expiration time, assume it's expiring soon
  }

  const expiresAt = session.expires_at * 1000; // Convert to milliseconds
  const now = Date.now();
  const timeUntilExpiry = (expiresAt - now) / 60000; // Convert to minutes
  //   console.log("timeUntilExpiry (minutes)", timeUntilExpiry - thresholdSeconds);

  return timeUntilExpiry < thresholdMinutes;
};
