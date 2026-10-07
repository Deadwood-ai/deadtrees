import { Alert, Button, Form, Input } from "antd";
import { Link, useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAnalytics } from "../../hooks/useAnalytics";
import { signUp } from "../../api/signup";
import Turnstile from "../../components/Turnstile";
import { Settings } from "../../config";

const MIN_PASSWORD_LENGTH = 6;

type SignUpFormValues = { email: string; password: string };

const SignUp = () => {
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo") || "/profile";
  const { track } = useAnalytics("auth");
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    track("sign_up_started", {
      auth_path: window.location.pathname + window.location.search,
    });
  }, [track]);

  const onFinish = async ({ email, password }: SignUpFormValues) => {
    if (!captchaToken) return;
    setError(null);
    setSubmitting(true);
    try {
      await signUp({ email, password, captchaToken, redirectTo: window.origin + returnTo });
      setSentTo(email);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign-up failed. Please try again.");
      setCaptchaReset((value) => value + 1);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="m-auto flex h-full max-w-7xl items-center justify-center">
      <div className="w-96 rounded-md p-8">
        <h1 className="mb-8 text-3xl font-semibold text-gray-600">Sign Up</h1>
        {sentTo ? (
          <Alert
            showIcon
            type="success"
            message="Check your inbox"
            description={`We sent a confirmation link to ${sentTo}. Open it to finish creating your account.`}
          />
        ) : (
          <>
            {error ? <Alert className="mb-4" showIcon type="error" message={error} /> : null}
            <Form layout="vertical" onFinish={onFinish} disabled={submitting} requiredMark={false}>
              <Form.Item
                label="Email address"
                name="email"
                rules={[{ required: true, type: "email", message: "Please enter a valid email address." }]}
              >
                <Input className="p-2" placeholder="Your email address" autoComplete="email" inputMode="email" />
              </Form.Item>
              <Form.Item
                label="Create a password"
                name="password"
                rules={[
                  { required: true, message: "Please choose a password." },
                  { min: MIN_PASSWORD_LENGTH, message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` },
                ]}
              >
                <Input.Password className="p-2" placeholder="Your password" autoComplete="new-password" />
              </Form.Item>
              <Form.Item>
                {Settings.TURNSTILE_SITE_KEY ? (
                  <Turnstile siteKey={Settings.TURNSTILE_SITE_KEY} onToken={setCaptchaToken} resetKey={captchaReset} />
                ) : (
                  <Alert showIcon type="warning" message="Sign-up is not available right now." />
                )}
              </Form.Item>
              <Button type="primary" htmlType="submit" block size="large" loading={submitting} disabled={!captchaToken}>
                Sign up
              </Button>
            </Form>
          </>
        )}
        <div className="pt-4 text-center">
          <Link className="block pb-2 text-blue-500" to={`/sign-in${returnTo !== "/profile" ? `?returnTo=${returnTo}` : ""}`}>
            Already have an account?
          </Link>
        </div>
      </div>
    </div>
  );
};

export default SignUp;
