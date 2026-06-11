import { Alert } from "antd";
import { SignIn as SignInAuthUI } from "@supabase/auth-ui-react";
import { ThemeSupa } from "@supabase/auth-ui-shared";
import { useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "../../hooks/useSupabase";
import { palette } from "../../theme/palette";

const SignIn = () => {
  const [searchParams] = useSearchParams();
  const authUiWrapperRef = useRef<HTMLDivElement>(null);
  const returnTo = searchParams.get("returnTo") || "/profile";
  const sessionExpired = searchParams.get("reason") === "session_expired";

  useEffect(() => {
    const updateAutocompleteAttributes = () => {
      const wrapper = authUiWrapperRef.current;
      if (!wrapper) return;

      const emailInput = wrapper.querySelector<HTMLInputElement>(
        'input[type="email"], input[name="email"]',
      );
      emailInput?.setAttribute("autocomplete", "email");
      emailInput?.setAttribute("inputmode", "email");

      const passwordInput =
        wrapper.querySelector<HTMLInputElement>('input[type="password"]');
      passwordInput?.setAttribute("autocomplete", "current-password");
    };

    updateAutocompleteAttributes();
    const observer = new MutationObserver(updateAutocompleteAttributes);
    if (authUiWrapperRef.current) {
      observer.observe(authUiWrapperRef.current, {
        childList: true,
        subtree: true,
      });
    }

    return () => observer.disconnect();
  }, []);

  return (
    <div className="m-auto flex h-full  max-w-7xl items-center justify-center">
      <div className="w-96 rounded-md p-8">
        <h1 className="mb-8 text-3xl font-semibold text-gray-600">Sign In</h1>
        {sessionExpired ? (
          <Alert
            type="warning"
            showIcon
            className="mb-4"
            message="Your session expired. Please sign in again."
          />
        ) : null}
        <div ref={authUiWrapperRef}>
          <SignInAuthUI
            supabaseClient={supabase}
            providers={[]}
            appearance={{
              theme: ThemeSupa,
              variables: {
                default: {
                  colors: {
                    brand: palette.primary[500],
                    brandAccent: palette.primary[600],
                    defaultButtonBackground: palette.primary[500],
                    defaultButtonBackgroundHover: palette.primary[600],
                  },
                  fontSizes: {
                    baseBodySize: "16px",
                    baseInputSize: "16px",
                    baseLabelSize: "16px",
                    baseButtonSize: "16px",
                  },
                },
              },
            }}
            redirectTo={window.origin + returnTo}
          />
        </div>
        <div className="pt-4 text-center">
          Not registered yet?{" "}
          <Link to={`/sign-up${returnTo !== "/profile" ? `?returnTo=${returnTo}` : ""}`} className="text-blue-500 underline">
            Create an account
          </Link>
        </div>
        <div className="pt-4 text-center">
          Forgott password?{" "}
          <Link to="/forgot-password" className="text-blue-500 underline">
            Reset Password
          </Link>
        </div>
      </div>
    </div>
  );
};

export default SignIn;
