import { Alert, Button, Form, Input } from "antd";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "../../hooks/useSupabase";
import AuthCard, { AuthLink, returnQuery } from "./AuthCard";

type SignInFormValues = { email: string; password: string };

function describeSignInError(message: string): string {
  if (/invalid login credentials/i.test(message))
    return "Email or password is not correct.";
  if (/email not confirmed/i.test(message))
    return "Please confirm your email address first. Check your inbox for the link.";
  return message || "Signing in failed. Please try again.";
}

const SignIn = () => {
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo") || "/profile";
  const sessionExpired = searchParams.get("reason") === "session_expired";
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Signing in is enough: PublicOnly sends a signed-in visitor on to returnTo.
  const onFinish = async ({ email, password }: SignInFormValues) => {
    setError(null);
    setSubmitting(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setSubmitting(false);
    if (signInError) setError(describeSignInError(signInError.message));
  };

  return (
    <AuthCard
      title="Sign In"
      footer={
        <>
          <div>
            Not registered yet?{" "}
            <AuthLink to={`/sign-up${returnQuery(returnTo)}`}>
              Create an account
            </AuthLink>
          </div>
          <div>
            <AuthLink to="/forgot-password">Forgot your password?</AuthLink>
          </div>
        </>
      }
    >
      {sessionExpired ? (
        <Alert
          type="warning"
          showIcon
          className="mb-4"
          message="Your session expired. Please sign in again."
        />
      ) : null}
      {error ? (
        <Alert type="error" showIcon className="mb-4" message={error} />
      ) : null}
      <Form
        layout="vertical"
        onFinish={onFinish}
        disabled={submitting}
        requiredMark={false}
      >
        <Form.Item
          label="Email address"
          name="email"
          rules={[
            {
              required: true,
              type: "email",
              message: "Please enter your email address.",
            },
          ]}
        >
          <Input
            size="large"
            placeholder="Your email address"
            autoComplete="email"
            inputMode="email"
          />
        </Form.Item>
        <Form.Item
          label="Password"
          name="password"
          rules={[{ required: true, message: "Please enter your password." }]}
        >
          <Input.Password
            size="large"
            placeholder="Your password"
            autoComplete="current-password"
          />
        </Form.Item>
        <Button
          type="primary"
          htmlType="submit"
          block
          size="large"
          loading={submitting}
        >
          Sign in
        </Button>
      </Form>
    </AuthCard>
  );
};

export default SignIn;
