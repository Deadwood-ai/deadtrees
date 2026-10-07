import { Settings } from "../config";

export interface SignupInput {
  email: string;
  password: string;
  captchaToken: string;
  redirectTo: string;
}

/**
 * Create an account through the API, which checks the captcha and emails a
 * confirmation link. The answer is the same whether or not the email is known.
 */
export async function signUp(input: SignupInput): Promise<string> {
  const response = await fetch(`${Settings.API_URL}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      captcha_token: input.captchaToken,
      redirect_to: input.redirectTo,
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.detail;
    throw new Error(typeof detail === "string" ? detail : "Sign-up failed. Please check your details and try again.");
  }
  return body.message as string;
}
