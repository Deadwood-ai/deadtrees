import { Settings } from "../config";
import { readError } from "./datasetAccess";

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
  if (!response.ok) throw new Error(await readError(response));
  return ((await response.json()) as { message: string }).message;
}
