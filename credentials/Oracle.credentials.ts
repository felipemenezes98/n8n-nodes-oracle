import { ICredentialType, INodeProperties } from "n8n-workflow";

export type IOracleCredentials = {
  user: string;
  password: string;
  connectionString: string;
};

export class Oracle implements ICredentialType {
  name = "oracleCredentials";
  displayName = "Oracle Credentials";
  documentationUrl = "oracleCredentials";
  properties: INodeProperties[] = [
    {
      displayName: "UserS",
      name: "user",
      type: "string",
      default: "system",
    },
    {
      displayName: "PasswordS",
      name: "password",
      type: "string",
      typeOptions: {
        password: true,
      },
      default: "",
    },
    {
      displayName: "Connection StringS",
      name: "connectionString",
      type: "string",
      default: "localhost/orcl",
    },
    {
      displayName: "Use Thin modeS",
      name: "thinMode",
      type: "boolean",
      default: true,
      description: "Define type of connection with database",
    },
  ];
}
