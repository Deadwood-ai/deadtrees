// import { UpdatePassword as UpdatePasswordAuthUI } from "@supabase/auth-ui-react";
// import { ThemeSupa } from "@supabase/auth-ui-shared";
import { supabase } from "../../hooks/useSupabase";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import Input from "antd/es/input/Input";
import { Button, Form, message } from "antd";

const ResetPassword = () => {
  const [password, setPassword] = useState("");
  const navigate = useNavigate();

  const handleChange = (e) => {
    setPassword(e.target.value);
  };

  const onFormSubmit = async () => {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      console.debug(error);
    } else {
      navigate("/profile");
      message.success("Password updated successfully");
    }
  };

  return (
    <div className="m-auto flex h-full max-w-7xl items-center justify-center">
      <div className="w-96 rounded-md bg-white p-8">
        <h1 className="mb-8 text-3xl font-semibold text-gray-600">Reset Password</h1>
        <Form layout="vertical" onFinish={onFormSubmit}>
          <Form.Item required={true} label="New Password">
            <Input className="w-full p-2" type="password" placeholder="New Password" onChange={handleChange} />
          </Form.Item>
          <Form.Item>
            <Button className="w-full" size="large" type="primary" htmlType="submit">
              Reset Password
            </Button>
          </Form.Item>
        </Form>
      </div>
    </div>
  );
};

export default ResetPassword;
