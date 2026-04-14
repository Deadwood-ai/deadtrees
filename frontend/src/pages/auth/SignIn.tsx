import { SignIn as SignInAuthUI } from "@supabase/auth-ui-react";
import { ThemeSupa } from "@supabase/auth-ui-shared";
import { supabase } from "../../hooks/useSupabase";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useEffect } from "react";
import { useAuth } from "../../hooks/useAuthProvider";
import { palette } from "../../theme/palette";

const SignIn = () => {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo") || "/profile";

  useEffect(() => {
    if (session) {
      navigate(returnTo);
    }
  }, [session, navigate, returnTo]);

  return (
    <div className="m-auto flex h-full  max-w-7xl items-center justify-center">
      <div className="w-96 rounded-md p-8">
        <h1 className="mb-8 text-3xl font-semibold text-gray-600">Sign In</h1>
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
