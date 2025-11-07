let counter = 0;

export const v4 = () => {
  counter++;
  return `test-uuid-${counter}`;
};

const mockUuid = {
  v4,
};

export default mockUuid;
