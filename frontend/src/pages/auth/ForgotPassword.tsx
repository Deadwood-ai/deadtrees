import { Alert, Button, Form, Input } from "antd";
import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../hooks/useSupabase";
import AuthCard from "./AuthCard";

const ForgotPassword = () => {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const onFinish = async ({ email }: { email: string }) => {
    setError(null);
    setSubmitting(true);
    const address = email.trim();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      address,
      {
        redirectTo: window.origin + "/reset-password",
      },
    );
    setSubmitting(false);
    if (resetError)
      setError(
        resetError.message || "The email could not be sent. Please try again.",
      );
    else setSentTo(address);
  };

  return (
    <AuthCard
      title="Forgot Password"
      subtitle={
        sentTo
          ? undefined
          : "Enter your email address and we'll send you a link to choose a new password."
      }
      footer={
        <>
          <div>
            Remembered it?{" "}
            <Link
              to="/sign-in"
              className="font-medium text-[#1B5E35] underline hover:text-emerald-800"
            >
              Sign in
            </Link>
          </div>
          <div>
            Not registered yet?{" "}
            <Link
              to="/sign-up"
              className="font-medium text-[#1B5E35] underline hover:text-emerald-800"
            >
              Create an account
            </Link>
          </div>
        </>
      }
    >
      {sentTo ? (
        <Alert
          showIcon
          type="success"
          message="Check your inbox"
          description={`If an account exists for ${sentTo}, we sent it a link to choose a new password.`}
        />
      ) : (
        <>
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
            <Button
              type="primary"
              htmlType="submit"
              block
              size="large"
              loading={submitting}
            >
              Send reset link
            </Button>
          </Form>
        </>
      )}
    </AuthCard>
  );
};

export default ForgotPassword;
