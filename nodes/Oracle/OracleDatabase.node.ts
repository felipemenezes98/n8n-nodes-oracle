import { IExecuteFunctions } from "n8n-core";
import {
  IDataObject,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from "n8n-workflow";

import oracledb from "oracledb";
import { OracleConnection } from "./core/connection";

export class OracleDatabase implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Oracle Database with Parameterization",
    name: "oracleDatabaseWithParameterization",
    icon: "file:oracle.svg",
    group: ["input"],
    version: 1,
    description: "Upsert, get, add and update data in Oracle database",
    defaults: {
      name: "Oracle Database",
    },
    inputs: ["main"],
    outputs: ["main"],
    credentials: [
      {
        name: "oracleCredentials",
        required: true,
      },
    ],
    properties: [
      {
        displayName: "SQL Statement",
        name: "query",
        type: "string",
        typeOptions: {
          alwaysOpenEditWindow: true,
        },
        default: "",
        placeholder: "SELECT id, name FROM product WHERE id < :param_name",
        required: true,
        description: "The SQL query to execute",
      },
      {
        displayName: "Parameters",
        name: "params",
        placeholder: "Add Parameter",
        type: "fixedCollection",
        typeOptions: {
          multipleValues: true,
          multipleValueButtonText: "Add another Parameter",
        },
        default: {},
        options: [
          {
            displayName: "Values",
            name: "values",
            values: [
              {
                displayName: "Name",
                name: "name",
                type: "string",
                default: "",
                placeholder: "e.g. param_name (sem dois pontos)",
                required: true,
              },
              {
                displayName: "Value",
                name: "value",
                type: "string",
                default: "",
                placeholder: "Ex.: 12345 ou ABC",
                required: true,
              },
              {
                displayName: "Data Type",
                name: "datatype",
                type: "options",
                required: true,
                default: "string",
                options: [
                  { name: "String", value: "string" },
                  { name: "Number", value: "number" },
                ],
              },
              {
                displayName: "Parse for IN statement",
                name: "parseInStatement",
                type: "options",
                required: true,
                default: false,
                hint: 'Se "Yes", o campo "Value" deve ser uma string com valores separados por vírgula. Ex: 1,2,3 ou ABC,XYZ',
                options: [
                  { name: "No", value: false },
                  { name: "Yes", value: true },
                ],
              },
            ],
          },
        ],
      },
      {
        displayName: "Include Metadata",
        name: "includeMetadata",
        type: "boolean",
        default: false,
        description:
          'Se marcado, retorna também a chave "metaData" no resultado (o objeto result completo). Se não, retorna somente as linhas.',
      },
      {
        displayName: "Row Limit",
        name: "rowLimit",
        type: "options",
        default: 0,
        required: true,
        description:
          "Limite de linhas para adicionar ao final do SQL via FETCH FIRST X ROWS ONLY",
        options: [
          {
            name: "No limit",
            value: 0,
          },
          {
            name: "100",
            value: 100,
          },
          {
            name: "1.000",
            value: 1000,
          },
          {
            name: "10.000",
            value: 10000,
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    // Polyfill for old Node versions without replaceAll
    if (typeof String.prototype.replaceAll === "undefined") {
      String.prototype.replaceAll = function (
        match: string | RegExp,
        replace: string
      ): string {
        return this.replace(new RegExp(match, "g"), replace);
      };
    }

    // Get credentials
    const credentials = await this.getCredentials("oracleCredentials");
    const oracleCredentials = {
      user: String(credentials.user),
      password: String(credentials.password),
      connectionString: String(credentials.connectionString),
    };

    // Custom connection
    const db = new OracleConnection(
      oracleCredentials,
      Boolean(credentials.thinMode)
    );
    const connection = await db.getConnection();

    // Array that will contain the return items
    let returnItems: INodeExecutionData[] = [];

    try {
      // Captures the query typed
      let query = this.getNodeParameter("query", 0) as string;

      // Captures the parameter list
      const parameterList =
        ((this.getNodeParameter("params", 0, {}) as IDataObject).values as {
          name: string;
          value: string | number;
          datatype: string;
          parseInStatement: boolean;
        }[]) || [];

      // Checkbox "include metadata"?
      const includeMetadata = this.getNodeParameter(
        "includeMetadata",
        0
      ) as boolean;

      // Selected value for rowLimit
      const rowLimit = this.getNodeParameter("rowLimit", 0) as number;

      // Builds the bind parameters object
      const bindParameters: Record<string, oracledb.BindParameter> =
        parameterList.reduce((acc, param) => {
          // Defines if it's NUMBER or STRING
          const dataType =
            param.datatype === "number" ? oracledb.NUMBER : oracledb.STRING;

          // If it's not parseInStatement, it's just a normal bind
          if (!param.parseInStatement) {
            acc[param.name] = {
              type: dataType,
              val:
                param.datatype === "number"
                  ? Number(param.value)
                  : String(param.value),
            };
            return acc;
          }

          // If it's parseInStatement, "expands" into multiple parameters
          const crypto = require("crypto");
          const valuesArray = param.value.toString().split(",");
          let inClause = "(";

          for (let i = 0; i < valuesArray.length; i++) {
            const uniqueSuffix = crypto.randomUUID().replaceAll("-", "_");
            const newParamName = param.name + uniqueSuffix;

            acc[newParamName] = {
              type: dataType,
              val:
                param.datatype === "number"
                  ? Number(valuesArray[i])
                  : String(valuesArray[i]),
            };

            inClause += `:${newParamName},`;
          }

          // Remove final comma and close
          inClause = inClause.slice(0, -1) + ")";

          // Replaces in query the :original with the inClause
          query = query.replaceAll(`:${param.name}`, inClause);

          return acc;
        }, {} as Record<string, oracledb.BindParameter>);

      // If rowLimit > 0, adds the FETCH FIRST X ROWS ONLY clause
      if (rowLimit > 0) {
        // Check if the query already has a semicolon at the end, etc.
        // Simple example: just concatenate.
        query += ` FETCH FIRST ${rowLimit} ROWS ONLY`;
      }

      // Executes the query
      const result = await connection.execute(query, bindParameters, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        autoCommit: true,
        // If the user marked to include metadata, enables extendedMetaData
        // Otherwise, false
        extendedMetaData: includeMetadata,
      });

      if (includeMetadata) {
        // If we marked "Include Metadata", returns a single item containing the entire result
        returnItems.push({
          json: result as unknown as IDataObject, // casting to IDataObject
        });
      } else {
        // Otherwise, returns only the rows (one item per row)
        const rows = (result.rows || []) as IDataObject[];
        for (const row of rows) {
          returnItems.push({ json: row });
        }
      }
    } catch (error) {
      throw new NodeOperationError(this.getNode(), error as Error);
    } finally {
      // Closes the connection with the DB
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          console.error(`Error closing connection with OracleDB: ${closeErr}`);
        }
      }
    }

    // Returns the items
    return [returnItems];
  }
}

// Polyfill (for Node < 15)
declare global {
  interface String {
    replaceAll(searchValue: string | RegExp, replaceValue: string): string;
  }
}

if (typeof String.prototype.replaceAll === "undefined") {
  String.prototype.replaceAll = function (
    match: string | RegExp,
    replace: string
  ): string {
    return this.replace(new RegExp(match, "g"), replace);
  };
}
