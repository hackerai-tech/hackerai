// Simple mock for @workos-inc/node
class WorkOS {
  userManagement = {
    getUser: jest.fn(),
    listUsers: jest.fn(),
    createUser: jest.fn(),
    updateUser: jest.fn(),
    deleteUser: jest.fn(),
  };

  organizations = {
    getOrganization: jest.fn(),
    listOrganizations: jest.fn(),
  };

  sso = {
    getConnection: jest.fn(),
  };
}

export { WorkOS };
export default WorkOS;
