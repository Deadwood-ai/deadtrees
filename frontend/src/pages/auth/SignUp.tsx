import { Alert, Button, Form, Input } from "antd";
import { Link, useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAnalytics } from "../../hooks/useAnalytics";
import { signUp } from "../../api/signup";
import Turnstile from "../../components/Turnstile";
import { Settings } from "../../config";
import AuthCard from "./AuthCard";

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
      await signUp({
        email,
        password,
        captchaToken,
        redirectTo: window.origin + returnTo,
      });
      setSentTo(email);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Sign-up failed. Please try again.",
      );
      setCaptchaReset((value) => value + 1);
    } finally {
      setSubmitting(false);
    }
  };

  const returnQuery =
    returnTo !== "/profile" ? `?returnTo=${encodeURIComponent(returnTo)}` : "";

  return (
    <AuthCard
      title="Sign Up"
      subtitle={
        sentTo
          ? undefined
          : "Create a free account to upload drone imagery and download data."
      }
      footer={
        <div>
          <Link
            to={`/sign-in${returnQuery}`}
            className="font-medium text-[#1B5E35] underline hover:text-emerald-800"
          >
            Already have an account?
          </Link>
        </div>
      }
    >
      {sentTo ? (
        <Alert
          showIcon
          type="success"
          message="Check your inbox"
          description={`We sent a confirmation link to ${sentTo}. Open it to finish creating your account.`}
        />
      ) : (
        <>
          {error ? (
            <Alert className="mb-4" showIcon type="error" message={error} />
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
                  message: "Please enter a valid email address.",
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
              label="Create a password"
              name="password"
              extra={`At least ${MIN_PASSWORD_LENGTH} characters.`}
              rules={[
                { required: true, message: "Please choose a password." },
                {
                  min: MIN_PASSWORD_LENGTH,
                  message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
                },
              ]}
            >
              <Input.Password
                size="large"
                placeholder="Your password"
                autoComplete="new-password"
              />
            </Form.Item>
            <Form.Item>
              {Settings.TURNSTILE_SITE_KEY ? (
                <Turnstile
                  siteKey={Settings.TURNSTILE_SITE_KEY}
                  onToken={setCaptchaToken}
                  resetKey={captchaReset}
                />
              ) : (
                <Alert
                  showIcon
                  type="warning"
                  message="Sign-up is not available right now."
                />
              )}
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              size="large"
              loading={submitting}
              disabled={!captchaToken}
            >
              Sign up
            </Button>
          </Form>
        </>
      )}
    </AuthCard>
  );
};

export default SignUp;
