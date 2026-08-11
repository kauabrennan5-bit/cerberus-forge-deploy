import React from 'react';
import { CERBERUS_LOGO_SRC } from '../assets/cerberusLogo';

interface CerberusLogoProps {
  className?: string;
  size?: number;
}

export const CerberusLogo: React.FC<CerberusLogoProps> = ({
  className = "w-8 h-8",
  size
}) => {
  return (
    <div
      className={`relative inline-flex items-center justify-center shrink-0 ${className}`}
      style={size ? { width: `${size}px`, height: `${size}px` } : undefined}
    >
      <img
        src={CERBERUS_LOGO_SRC}
        alt="Cerberus"
        className="w-full h-full object-contain select-none pointer-events-none"
      />
    </div>
  );
};
