import { ForgottenPassword as ForgotpasswordAuthUI } from "@supabase/auth-ui-react";
import { ThemeSupa } from "@supabase/auth-ui-shared";
import { supabase } from "../../hooks/useSupabase";
import { Link } from "react-router-dom";
import { palette } from "../../theme/palette";

const Forgotpassword = () => {
  return (
    <div className="m-auto flex h-full max-w-7xl items-center justify-center">
      <div className="w-96 rounded-md p-8">
        <h1 className="mb-8 text-3xl font-semibold text-gray-600"> Forgot Password</h1>
        <ForgotpasswordAuthUI
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
          redirectTo={window.origin + "/reset-password"}
        />

        <div className="pt-4 text-center">
          Not registered yet?{" "}
          <Link to="/sign-up" className="text-blue-500 underline">
            Create an account
          </Link>
        </div>
      </div>
    </div>
  );
};

export default Forgotpassword;
