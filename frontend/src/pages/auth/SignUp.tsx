import { SignUp as SignUpAuthUI } from "@supabase/auth-ui-react";
import { ThemeSupa } from "@supabase/auth-ui-shared";
import { supabase } from "../../hooks/useSupabase";
import { Link, useSearchParams } from "react-router-dom";
import { useEffect } from "react";
import { palette } from "../../theme/palette";
import { useAnalytics } from "../../hooks/useAnalytics";

const SignUp = () => {
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo") || "/profile";
  const { track } = useAnalytics("auth");

  useEffect(() => {
    track("sign_up_started", {
      auth_path: window.location.pathname + window.location.search,
    });
  }, [track]);

  return (
    <div className="m-auto flex h-full max-w-7xl items-center justify-center">
      <div className="w-96 rounded-md p-8">
        <h1 className="mb-8 text-3xl font-semibold text-gray-600">Sign Up</h1>
        <SignUpAuthUI
          providers={[]}
          supabaseClient={supabase}
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
